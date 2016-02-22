/**
 * This work is provided under the terms of the CREATIVE COMMONS PUBLIC
 * LICENSE. This work is protected by copyright and/or other applicable
 * law. Any use of the work other than as authorized under this license
 * or copyright law is prohibited.
 *
 * http://creativecommons.org/licenses/by-nc-sa/4.0/
 *
 * © 2016 Matthias Biggeleben <biggeleben@gmail.com>
 */

var Imap = require('imap'),
    mime = require('mimelib'),
    $ = require('jquery-deferred'),
    _ = require('underscore'),
    moment = require('moment'),
    iconv = require('iconv-lite'),
    sanitize = require('sanitize-html'),
    util = require('./util'),
    config = require('../config');

var imap = new Imap({
    user: config.user,
    password: config.password,
    host: config.host,
    port: config.port,
    tls: true,
    authTimeout: 3000
    // debug: function (cmd) { console.log(cmd); }
});

//
// Connetion handling
//

var ready = $.Deferred();

function onReady() {
    ready.resolve();
}

function onError(err) {
    ready.reject(err);
}

function onEnd() {
    console.error('Connection ended');
    ready.reject();
}

imap.on('ready', onReady);
imap.once('error', onError);
imap.once('end', onEnd);
imap.connect();

function reconnect() {
    ready.reject();
    ready = $.Deferred();
    imap.connect();
    return ready.promise();
}

//
// Fetch / Search
//

function fetchEnvelope(folder) {

    return selectBox(folder, true).then(function (box) {
        var total = box.messages.total,
            start = Math.max(1, total - 50),
            range = start + ':' + total;
        if (total === 0) return $.when([]);
        var f = imap.seq.fetch(range, {
            bodies: 'HEADER.FIELDS (X-PRIORITY CONTENT-TYPE)',
            envelope: true,
            size: true,
            struct: false
        });
        return processEnvelope(f, folder);
    });
}

function searchEnvelope(folder, query) {

    query = String(query || '').trim();

    // over virtual/all?
    if (query.indexOf(':all') === 0) {
        folder = 'virtual/all';
        query = query.substr(5);
    }

    if (query === '') return $.when([]);

    return selectBox(folder).then(function (box) {
        return search(parseQuery(query)).then(function (results) {
            if (results.length === 0) return $.when([]);
            results = _(results).last(100);
            var f = imap.fetch(results, {
                bodies: 'HEADER.FIELDS (X-PRIORITY CONTENT-TYPE)',
                extensions: folder === 'virtual/all' && ['X-MAILBOX', 'X-REAL-UID'],
                envelope: true,
                size: true,
                struct: false
            });
            return processEnvelope(f, folder);
        });
    });
}

function parseQuery(query) {
    // all lowercase
    query = query.toLowerCase();
    // uses special syntax?
    if (/(subject|from|to|cc|year)\:/.test(query)) {
        // split into sub queries
        var expressions = query.split(/(?:\s*)(\w+\:(?:"[^"]"|\w+))(?:\s*)/).map(function (phrase) {
            if (!phrase) return false;
            var pair = phrase.split(':', 2),
                field = pair[0],
                value = (pair[1] || '').replace(/^"|"$/g, '');
            switch (field) {
                case 'subject': return [['SUBJECT', value]];
                case 'from': return [['FROM', value]];
                case 'to': return [['TO', value]];
                case 'cc': return [['CC', value]];
                case 'year': return byYear(value);
                default: return [['SUBJECT', phrase]];
            }
        });
        return _(['UNDELETED'].concat(expressions)).chain().flatten(true).compact().value();
    } else {
        return ['UNDELETED', ['OR', ['SUBJECT', query], ['FROM', query]]]
    }
}

function byYear(value) {
    if (!/^\d+$/.test(value)) return false;
    var year = parseInt(value, 10);
    return [['SINCE', '01-Jan-' + year], ['BEFORE', '01-Jan-' + (year + 1)]];
}

//
// Select mailbox with retry
//

var selectBox = (function () {

    var retryCount = 0;

    function openBox(folder, readOnly) {
        var def = $.Deferred();
        imap.openBox(folder, !!readOnly, function (err, box) {
            if (err) return def.reject(err); else def.resolve(box);
        });
        return def.promise();
    }

    function selectBox(folder, readOnly) {
        return ready.then(function () {
            try {
                return openBox(folder, readOnly);
            } catch (e) {
                if (e.toString() === 'Error: Not authenticated' && retryCount < 2) {
                    // retry once
                    retryCount++;
                    return reconnect().then(function () {
                        return selectBox(folder, readOnly).done(function () {
                            retryCount = 0;
                        });
                    });
                } else {
                    return $.Deferred().reject(e);
                }
            }
        });
    }

    return selectBox;

}());

function search(query) {
    var def = $.Deferred();
    imap.search(query, function (err, results) {
        if (err) def.reject(err); else def.resolve(results);
    });
    return def.promise();
}

function processEnvelope(f, mailbox) {

    var def = $.Deferred();
    var messages = [];

    f.on('message', function (msg, seqno) {
        var attr = {}, headers = '';
        msg.on('body', function(stream, info) {
            stream.on('data', function(chunk) {
                headers += chunk.toString('utf8');
            });
        });
        msg.once('attributes', function (attrs) {
            _.extend(attr, attrs);
        });
        msg.once('end', function() {
            headers = Imap.parseHeader(headers);
            var env = attr.envelope || {},
                contentType = getContentType(headers),
                folder = attr['x-mailbox'] || mailbox,
                uid = attr['x-real-uid'] || attr.uid;
            var result = {
                attachments: {
                    heuristic: contentType === 'multipart/mixed',
                    parts: null
                },
                bcc: packAddress(env.bcc),
                blockedImages: false,
                cc: packAddress(env.cc),
                cid: folder + '/' + uid,
                contentType: contentType,
                date: +moment(env.date),
                dateStr: util.getDate(env.date),
                dateFullStr: util.getFullDate(env.date),
                flags: getFlags(attr.flags),
                folder: folder,
                from: packAddress(env.from),
                id: uid,
                messageId: env.messageId,
                priority: getPriority(headers),
                replyTo: packAddress(env.replyTo),
                size: attr.size,
                seqno: seqno,
                subject: env.subject,
                to: packAddress(env.to)
            };
            if (attr.struct) result.struct = attr.struct;
            messages.push(result);
        });
    });
    f.once('error', function (error) {
        console.error('Error in processEnvelope()', error);
        def.reject(error);
    });
    f.once('end', function() {
        def.resolve(messages.reverse());
    });

    return def.promise();;
}

function packAddress(list) {
    return _(list).map(function (item) {
        var name = String(item.name || '').replace(/^["']+|["']+$/g, ''),
            address = String(item.mailbox + '@' + item.host).toLowerCase();
        return { name: name, address: address };
    });
}

function getContentType(headers) {
    var value = headers['content-type'];
    if (!_.isArray(value)) return 'text/plain';
    return String(value[0] || '').toLowerCase().split(';')[0];
}

function getPriority(headers) {
    var value = headers['x-priority'];
    if (!_.isArray(value)) return 3;
    return parseInt(value[0], 10);
}

function getFlags(value) {
    var result = { answered: false, deleted: false, draft: false, forwarded: false, seen: false, spam: false };
    _(value).each(function (flag) {
        var key = String(flag).substr(1).toLowerCase();
        if (flag[0] === '\\' && key in result) result[key] = true;
        if (flag === 'Junk') result.spam = true;
    });
    return result;
}

function getFilename(str) {
    if (!str) return '';
    var match = str.match(/filename=(["'])?(.+)\1(;|$)/);
    return match ? match[2] : '';
}

//
// Get parts
//

function fetchParts(folder, uid) {

    function getParts(obj) {
        if (_.isArray(obj)) return _(obj).map(getParts);
        if (_.isObject(obj) && obj.partID) return {
            cid: obj.id || '',
            charset: (obj.params && obj.params.charset) || '',
            content: '',
            contentType: obj.type + '/' + obj.subtype,
            disposition: (obj.disposition && obj.disposition.type) || 'inline',
            encoding: obj.encoding,
            filename: (obj.disposition && obj.disposition.params && obj.disposition.params.filename) || '',
            id: obj.partID,
            size: obj.size
        };
        return null;
    }

    return selectBox(folder, false).then(function (box) {
        var f = imap.fetch(uid, { envelope: true, struct: true });
        return processEnvelope(f, folder).then(function (result) {
            result = _.isArray(result) ? result[0] : result;
            var parts = getParts(result.struct || []);
            result.parts = _(parts).chain().flatten().compact().value();
            if (isHTML(result.parts)) result.contentType = 'text/html';
            return result;
        });
    });
}

//
// Get message
//

function fetchMessage(folder, uid) {

    var def = $.Deferred();

    fetchParts(folder, uid)
        .done(function (result) {

            var hash = getPartsHash(result.parts),
                contentParts = getContentParts(result.parts, folder, uid),
                mimeParts = getMimeParts(contentParts);

            var f = imap.fetch(uid, {
                bodies: mimeParts,
                markSeen: true,
                struct: false
            });

            f.on('message', function (msg) {
                msg.on('body', function(stream, info) {
                    var part = _(contentParts).findWhere({ id: info.which });
                    if (!part) return;
                    var buffer = new Buffer('');
                    stream.on('data', function (chunk) {
                        buffer = Buffer.concat([buffer, chunk]);
                    });
                    stream.once('end', function () {
                        if (part.encoding === 'base64') {
                            part.content = mime.decodeBase64(buffer.toString(), part.charset);
                        } else if (part.encoding === 'quoted-printable') {
                            part.content = mime.decodeQuotedPrintable(buffer.toString(), part.charset);
                        } else if (part.charset) {
                            part.content = iconv.decode(buffer, part.charset);
                        } else {
                            part.content = buffer.toString();
                        }
                        // clean up
                        if (part.contentType === 'text/plain') part.content = cleanUpText(part.content);
                    });
                });
            });
            f.once('error', function (error) {
                def.reject(error);
            });
            f.once('end', function() {
                result.hash = hash;
                delete result.struct;
                assembleContent(contentParts, result);
                fixImages(result);
                sanitizeHTML(result);
                addStructure(result);
                removeLeadingWhiteSpace(result);
                def.resolve(result);
            });
        })
        .fail(function (error) {
            def.reject(error);
        });

    return def.promise();
}

function getMimeParts(parts) {
    return _(parts)
        .chain()
        .filter(function (part) { return part.contentType.indexOf('text') === 0; })
        .pluck('id')
        .value();
}

function assembleContent(contentParts, data) {

    var isHTML = data.contentType === 'text/html',
        content = '',
        append = false;

    _(contentParts).each(function (part) {
        if (part.content) {
            if (!isHTML) {
                content += part.content;
                append = true;
            } else {
                if (append || part.contentType === 'text/html') {
                    if (!append) {
                        content += part.content;
                        append = true;
                    } else {
                        content = content.replace(/<\/body>/i, part.content + '</body>');
                    }
                }
            }
        }
        delete part.content;
    });

    data.content = content;

    // loop over all parts to gather attachments
    var attachments = _(data.parts).filter(function (part) {
        if (part.content === undefined) return false;
        if (part.disposition === 'inline') return false;
        delete part.content;
        return true;
    });

    // finally fix attachment flag
    data.attachments = {
        heuristic: attachments.length > 0,
        parts: attachments.length > 0 ? attachments : null
    };
}

function sanitizeHTML(data) {

    data.content = data.content
        // decode obfuscated ASCII
        // addresses this one: https://www.owasp.org/index.php/XSS_Filter_Evasion_Cheat_Sheet#Decimal_HTML_character_references
        .replace(/&#(\d+);/g, function (all, code) {
            code = parseInt(code, 10);
            if (code < 32 || code >= 127) return all;
            return String.fromCharCode(code);
        })
        // remove javascript URLs from CSS
        .replace(/<style.*?<\s*\/\s*style\s*>/gi, function (all) {
            return all.replace(/url\(["']?javascript:.*?["']?\)/, 'none');
        })
        // remove javascript URLs from inline style
        .replace(/style=("[^"]+"|'[^']+'|[^\s>]+)/gi, function (all) {
            return all.replace(/url\(["']?javascript:.*?["']?\)/, 'none');
        });

    data.content = sanitize(data.content, {
        allowedTags: [
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'p', 'a', 'ul', 'ol',
            'nl', 'li', 'b', 'i', 'strong', 'em', 'strike', 'code', 'hr', 'br', 'div',
            'table', 'thead', 'caption', 'tbody', 'tr', 'th', 'td', 'pre',
            'body', 'img', 'span', 'font', 'style', 'section', 'article', 'header', 'footer', 'dt', 'dd'
        ],
        allowedAttributes: {
            '*': ['class', 'style', 'align', 'width', 'height', 'role', 'aria-*', 'data-*'],
            'a': ['href', 'name', 'target', 'title'],
            'body': ['bgcolor'],
            'img': ['src', 'alt'],
            'table': ['bgcolor', 'border', 'cellspacing', 'cellpadding'],
            'td': ['valign', 'bgcolor']
        },
        nonTextTags: ['title', 'script', 'textarea', 'noscript'],
        selfClosing: ['img', 'br', 'hr'],
        allowedSchemes: ['http', 'https', 'ftp', 'mailto'],
        allowedSchemesByTag: {},
        transformTags: {
            'a': function (tagName, attribs) {
                attribs.target = '_blank';
                return { tagName: 'a', attribs: attribs };
            }
        }
    });
}

function addStructure(data) {
    if (data.contentType === 'text/plain') data.content = '<body>' + data.content + '</body>';
    data.content = '<!doctype html><html><head><meta charset="utf-8"></head>' + data.content + '</html>';
}

function removeLeadingWhiteSpace(data) {
    data.content = data.content.replace(/(<body[^>]*>)(\s+|<p>\s*(<br[^>]*>)*\s*<\/p>|<br[^>]*>)+/gi, '$1');
}

function cleanUpText(str) {
    return _.escape(str)
        // detect links
        .replace(/((?:(?:https?\:\/\/)|www\.).*?)(\s|([.,;!?])(\s|$))/g, '<a href="$1" target="_blank">$1</a>$2')
        // inject <br> into plain text
        .replace(/\r?\n/g, '<br>');
}

function isHTML(parts) {
    return !!_(parts).find(function (part) { return part.contentType === 'text/html'; });
}

function getContentParts(parts, folder, uid) {
    var html = isHTML(parts), append = false, result = [];
    _(parts).each(function (part) {
        // always attach common image types; ignore disposition but check "cid";
        // having a cid is an indicator that it's a references inline image anyway
        if (append && /^image\/(jpeg|png|bmp|gif)$/i.test(part.contentType) && !part.cid) {
            // append images if not yet inline (indicated by a cid)
            part.content = '<img src="mail/messages/' + folder + '/' + uid + '.' + part.id + '" class="injected">';
            result.push(part);
        }
        if (part.disposition !== 'inline') return;
        if (part.contentType === 'text/plain') {
            if (html && !append) return;
            append = true;
            result.push(part);
        } else if (html && part.contentType === 'text/html') {
            append = true;
            result.push(part);
        }
    });
    return result;
}

// hash to map cid to part ID
function getPartsHash(parts) {
    var hash = {};
    _(parts).each(function (part) {
        if (part.cid) hash[part.cid.replace(/^<|>$/g, '')] = part.id;
    });
    return hash;
}

function fixImages(data) {
    var folder = data.folder, id = data.id, hash = data.hash;
    data.content = data.content
        // block external images
        .replace(/<img(.*?)src=["']?(https?:[^"'\s>]+)["']?/gi, function (all, attr, src) {
            data.blockedImages = true;
            return '<img' + attr + 'src="//:0" data-original-src="' + src + '"';
        })
        // replace src of inline images
        .replace(/src=["']?cid:([^"']+)["']?/gi, function (all, cid) {
            return 'src="mail/messages/' + folder + '/' + id + '.' + hash[cid] + '"';
        });
}

//
// Fetch part/attachment
//

function fetchPart(folder, uid, part) {

    var def = $.Deferred();

    ready.done(function () {
        imap.openBox(folder, true, function (err, box) {
            if (err) return def.reject(err);
            var f = imap.fetch(uid, { bodies: [part + '.MIME', part], struct: false });
            var content = '', headers = {};
            f.on('message', function (msg) {
                msg.on('body', function(stream, info) {
                    var buffer = '';
                    stream.on('data', function (chunk) {
                        buffer += chunk.toString('utf8');
                    });
                    stream.once('end', function () {
                        if (info.which === part) content = buffer; else headers = Imap.parseHeader(buffer);
                        buffer = '';
                    });
                });
            });
            f.once('error', function (error) {
                def.reject(error);
            });
            f.once('end', function() {
                // determine encoding and decode content
                var encoding = _(headers['content-transfer-encoding']).first() || 'utf8';
                // get content type; split by first semi-colon
                var contentType = String(_(headers['content-type']).first() || 'text/plain').split(';')[0];
                // filename
                var filename = getFilename(_(headers['content-disposition']).first());
                // Done
                def.resolve({
                    content: content,
                    contentLength: content.length,
                    contentType: contentType,
                    encoding: encoding,
                    filename: filename,
                    headers: headers
                });
            });
        });
    });

    return def.promise();
}

function fetchMailboxes() {

    var def = $.Deferred();
    ready.done(function () {
        imap.getSubscribedBoxes(function (err, result) {
            if (err) return def.reject(err);
            result.INBOX.id = 'INBOX';
            def.resolve(sortMailboxes(result.INBOX, 0, 0));
        });
    });
    return def;
}

function sortMailboxes(box, parent, level) {

    var delimiter = box.delimiter || '/',
        id = parent ? parent + delimiter + box.id : box.id;

    var subfolders = _(box.children)
        .chain()
        // turn into an array
        .map(function (box, _id) {
            box.id = _id;
            return sortMailboxes(box, id, level + 1);
        })
        .sortBy(function (box) {
            return box.id.toLowerCase();
        })
        .value();

    box = {
        cid: id,
        id: id,
        level: level,
        parent: parent,
        subfolders: subfolders,
        title: box.id,
        type: getMailboxType(box)
    };

    return box;
}

function getMailboxType(box) {
    var attr = box.attribs || [];
    if (box.id === 'INBOX') return 'inbox';
    if (attr.indexOf('\\Trash') > -1) return 'trash';
    if (attr.indexOf('\\Drafts') > -1) return 'drafts';
    if (attr.indexOf('\\Junk') > -1) return 'spam';
    return 'mailbox';
}

module.exports = {
    connection: imap,
    selectBox: selectBox,
    fetchMailboxes: fetchMailboxes,
    fetchEnvelope: fetchEnvelope,
    searchEnvelope: searchEnvelope,
    fetchMessage: fetchMessage,
    fetchPart: fetchPart,
    getFlags: getFlags
};
