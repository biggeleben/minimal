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
    util = require('./util'),
    config = require('../config'),
    content = require('./content');

//
// Connection handling
//

function Connection(user, password) {

    var imap, ready = $.Deferred();

    function onReady() {
        ready.resolve(imap);
    }

    function onError(error) {
        console.error('Connection error', error);
        ready.reject(error);
    }

    function onEnd() {
        console.error('Connection ended');
        ready.reject();
    }

    //
    // Connect
    //

    var imap = new Imap({
        user: user,
        password: password,
        host: config.host,
        port: config.port,
        tls: true,
        authTimeout: 3000
        // debug: function (cmd) { console.log(cmd); }
    });

    imap.on('ready', onReady);
    imap.once('error', onError);
    imap.once('end', onEnd);
    imap.connect();

    this.reconnect = function () {
        ready.reject();
        ready = $.Deferred();
        imap.connect();
        return ready.promise();
    };

    this.end = function () {
        imap.end();
    };

    this.state = function () {
        return imap ? imap.state : 'disconnected';
    };

    this.promise = function () {
        return ready.promise();
    };

    this.raw = function () {
        return imap;
    };

    //
    // Select mailbox with retry
    //

    this.selectBox = (function () {

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

    //
    // Fetch envelope data
    //

    this.fetchEnvelope = function (folder, offset, limit) {

        offset = offset || 0;
        limit = limit || 50;

        return this.selectBox(folder, true).then(function (box) {

            var total = box.messages.total,
                start = Math.max(1, total - limit - offset + 1),
                range = start + ':' + (total - offset);

            if (total === 0 || offset >= total) return $.when({ messages: [], total: total });

            var f = imap.seq.fetch(range, {
                bodies: 'HEADER.FIELDS (X-PRIORITY CONTENT-TYPE)',
                envelope: true,
                size: true,
                struct: false
            });

            return processEnvelope(f, folder).then(function (list) {
                return { messages: list, total: total };
            });
        });
    };

    this.searchEnvelope = function (folder, query, offset, limit) {

        query = _.isArray(query) ? query : String(query || '').trim();
        offset = offset || 0;
        limit = limit || 50;

        // over virtual/all?
        if (query.indexOf(':all') === 0) {
            folder = 'virtual/all';
            query = query.substr(5);
        }

        if (query.length === 0) return $.when({ messages: [], total: 0 });

        return this.selectBox(folder).then(function (box) {
            return search(parseQuery(query)).then(function (results) {

                var total = results.length,
                    start = Math.max(0, total - limit - offset),
                    stop = total - offset;

                if (total === 0 || offset >= total) return $.when({ messages: [], total: total });

                results = results.slice(start, stop);

                var f = imap.fetch(results, {
                    bodies: 'HEADER.FIELDS (X-PRIORITY CONTENT-TYPE)',
                    extensions: folder === 'virtual/all' && ['X-MAILBOX', 'X-REAL-UID'],
                    envelope: true,
                    size: true,
                    struct: false
                });

                return processEnvelope(f, folder).then(function (list) {
                    return { messages: list, total: total };
                });
            });
        });
    };

    this.searchUnseen = function (folder) {
        return this.selectBox(folder).then(function (box) {
            return search(['UNSEEN', 'UNDELETED']);
        });
    };

    function parseQuery(query) {
        // bypass arrays
        if (_.isArray(query)) return query;
        // all lowercase
        query = query.toLowerCase();
        // unseen only?
        var flag = 'UNDELETED';
        if (/\:unseen/i.test(query)) {
            flag = 'UNSEEN';
            query = query.replace(/\:unseen/i, '');
        }
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
            return _([flag].concat(expressions)).chain().flatten(true).compact().value();
        } else if (query) {
            return [flag, ['OR', ['SUBJECT', query], ['FROM', query]]]
        } else {
            return [flag];
        }
    }

    function byYear(value) {
        if (!/^\d+$/.test(value)) return false;
        var year = parseInt(value, 10);
        return [['SINCE', '01-Jan-' + year], ['BEFORE', '01-Jan-' + (year + 1)]];
    }

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
                    cid: util.cid(folder, uid),
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

    this.fetchParts = function (folder, uid) {

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

        return this.selectBox(folder, false).then(function (box) {
            var f = imap.fetch(uid, { envelope: true, struct: true });
            return processEnvelope(f, folder).then(function (result) {
                result = _.isArray(result) ? result[0] : result;
                var parts = getParts(result.struct || []);
                result.parts = _(parts).chain().flatten().compact().value();
                if (content.isHTML(result.parts)) result.contentType = 'text/html';
                return result;
            });
        });
    };

    //
    // Get message
    //

    this.fetchMessage = function (folder, uid) {

        var def = $.Deferred();

        this.fetchParts(folder, uid)
            .done(function (result) {

                var hash = content.getPartsHash(result.parts),
                    contentParts = content.getContentParts(result.parts, folder, uid),
                    mimeParts = content.getMimeParts(contentParts);

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
                            if (part.contentType === 'text/plain') part.content = content.cleanUpText(part.content);
                        });
                    });
                });
                f.once('error', function (error) {
                    def.reject(error);
                });
                f.once('end', function() {
                    result.hash = hash;
                    delete result.struct;
                    content.assemble(contentParts, result);
                    content.sanitize(result);
                    content.addStructure(result);
                    content.removeLeadingWhiteSpace(result);
                    def.resolve(result);
                });
            })
            .fail(function (error) {
                def.reject(error);
            });

        return def.promise();
    }

    //
    // Fetch part/attachment
    //

    this.fetchPart = function (folder, uid, part) {

        return this.selectBox(folder).then(function (box) {
            var def = $.Deferred();
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
            return def.promise();
        });
    };

    //
    // Fetch mailboxes
    //
    this.fetchMailboxes = function () {

        return ready.then(function () {
            var def = $.Deferred();
            imap.getSubscribedBoxes(function (err, result) {
                if (err) return def.reject(err);
                result.INBOX.id = 'INBOX';
                def.resolve(sortMailboxes(result.INBOX, 0));
            });
            return def;
        })
        .then(function resort(inbox) {

            var specialUse = [inbox], mailboxes = [], hash = {};

            // just look below INBOX - first iteration considers special use flags
            mailboxes = _(inbox.subfolders).filter(function (item) {
                if (/^(archive|drafts|sent|spam|trash)$/.test(item.special)) {
                    hash[item.special] = true;
                    specialUse.push(item);
                    if (item.special === 'archive') sortArchive(item);
                    return false;
                }
                return true;
            });

            var flags = {
                drafts: /^(Drafts)$/i,
                sent: /^(Sent|Sent\s(items|messages|objects))$/i,
                spam: /^(Spam|Junk)$/i,
                trash: /^(Trash|Deleted\s(items|messages|objects))$/i,
                archive: /^(Archive)$/i
            };

            // 2nd iteration - consider id
            mailboxes = _(mailboxes).filter(function (item) {
                for (var special in flags) {
                    if (!hash[special] && flags[special].test(item.title)) {
                        item.special = special;
                        hash[special] = true;
                        specialUse.push(item);
                        if (item.special === 'archive') sortArchive(item);
                        return false;
                    }
                }
                return true;
            });

            inbox.subfolders = [];
            inbox.title = 'Inbox';

            // sort special-use folders
            var sorting = { inbox: 0, drafts: 1, sent: 2, spam: 3, trash: 4, archive: 5 };
            specialUse = _(specialUse).sortBy(function (box) {
                return sorting[box.special];
            });

            inheritSpecialUse(specialUse);

            specialUse.push({
                cid: 'mailboxes',
                id: 'mailboxes',
                level: 0,
                selectable: false,
                special: '',
                subfolders: mailboxes,
                title: 'My folders'
            });

            var root = {
                cid: 'root',
                id: 'root',
                level: 0,
                selectable: false,
                special: '',
                subfolders: specialUse,
                title: 'root'
            };

            fixNestingLevels(0, root);

            return root;
        });
    }

    function sortMailboxes(box, parent) {

        var delimiter = box.delimiter || '/',
            id = parent ? parent + delimiter + box.id : box.id;

        var subfolders = _(box.children)
            .chain()
            // turn into an array
            .map(function (box, _id) {
                box.id = _id;
                return sortMailboxes(box, id);
            })
            .sortBy(function (box) {
                return box.id.toLowerCase();
            })
            .value();

        box = {
            cid: id,
            id: id,
            level: 0,
            special: getSpecialUse(box),
            subfolders: subfolders,
            title: box.id
        };

        return box;
    }

    function getSpecialUse(box) {
        var attr = box.attribs || [];
        if (box.id === 'INBOX') return 'inbox';
        if (attr.indexOf('\\Trash') > -1) return 'trash';
        if (attr.indexOf('\\Drafts') > -1) return 'drafts';
        if (attr.indexOf('\\Junk') > -1) return 'spam';
        return '';
    }

    function fixNestingLevels(level, box) {
        box.level = level;
        _(box.subfolders).each(fixNestingLevels.bind(null, level + 1));
    }

    function sortArchive(box) {
        if (!box.subfolders.length || !/^\d+$/.test(box.subfolders[0].title)) return;
        box.subfolders = _(box.subfolders).sortBy(function (box) {
            return -parseInt(box.title, 10);
        });
    }

    function inheritSpecialUse(list, special) {
        _(list).each(function (box) {
            if (box.special === '') box.special = special || '';
            inheritSpecialUse(box.subfolders, box.special);
        });
    }

    //
    // Get threads
    //
    this.thread = function (folder, offset, limit) {

        offset = offset || 0;
        limit = limit || 50;

        function thread() {
            var def = $.Deferred();
            imap.thread('references', ['UNDELETED'], function (err, uids) {
                if (err) return def.reject(err.toString());
                def.resolve(uids);
            });
            return def.promise();
        }

        return this.selectBox(folder).then(function () {

            return thread().then(function (threads) {

                var total = threads.length,
                    start = Math.max(0, total - limit - offset),
                    stop = total - offset;

                if (total === 0 || offset >= total) return $.when({ messages: [], total: total });

                // get proper subset
                threads = threads.slice(start, stop);

                // get all uids
                var all_uids = [];

                // get flat thread structure, i.e. remove nesting
                threads = threads.map(function (thread) {
                    var uids = _(thread).flatten();
                    all_uids.push.apply(all_uids, uids);
                    return uids;
                });

                var f = imap.fetch(all_uids, {
                    bodies: 'HEADER.FIELDS (X-PRIORITY CONTENT-TYPE)',
                    envelope: true,
                    size: true,
                    struct: false
                });

                return processEnvelope(f, folder).then(function (list) {
                    // create hash
                    var hash = {};
                    _(list).each(function (item) { hash[item.id] = item; });
                    // replace id by message
                    threads = threads.map(function (thread) {
                        thread = _(thread.map(function (id) { return hash[id]; })).compact();
                        var last = _(thread).last();
                        var base = _.extend({ threadSize: thread.length, thread: thread.slice().reverse() }, _(thread).first());
                        _.extend(base, _(last).pick('date', 'dateStr', 'dateFullStr', 'from'))
                        return base;
                    });
                    // fix sort order
                    threads = _(threads).sortBy('date');
                    return { messages: threads.reverse(), total: total };
                });
            });
        });
    };

    //
    // Move message
    //
    this.move = function (source, messages, target) {
        return this.selectBox(source).then(function () {
            var def = $.Deferred();
            imap.move(messages, target, function (err) {
                if (err) def.reject(err.toString()); else def.resolve();
            });
            return def;
        });
    };

    //
    // Expunge mailbox
    //
    this.expunge = function (folder) {
        return this.selectBox(folder).then(function () {
            var def = $.Deferred();
            imap.closeBox(true, function (err) {
                if (err) def.reject(err.toString()); else def.resolve();
            });
            return def;
        });
    };

    this.getFlags = getFlags;
}

// simple hash to store connection per session id
var connections = {};

// get an existing or new connection based on request
function getConnection(req, res) {

    var def = $.Deferred(), id, connection;

    if (!req.session || !req.session.id) {
        fail();
        return def.promise();
    }

    id = req.session.id;
    connection = connections[id];

    if (connection && connection.state() === 'authenticated') {
        def.resolve(connection);
    } else if (req.session && req.session.user && req.session.password) {
        connection = new Connection(req.session.user, req.session.password)
        connection.promise()
            .done(function () {
                connections[id] = connection;
                def.resolve(connection);
            })
            .fail(fail);
    } else {
        fail();
    }

    function fail() {
        res.status(401).type('json').send('{}');
        def.reject();
    }

    return def.promise();
}

// get an existing or new connection based on session
function getConnectionBySession(id, session) {

    var def = $.Deferred(), connection = connections[id];

    if (connection && connection.state() === 'authenticated') {
        def.resolve(connection);
    } else if (session.user && session.password) {
        connection = new Connection(session.user, session.password)
        connection.promise()
            .done(function () {
                connections[id] = connection;
                def.resolve(connection);
            })
            .fail(def.reject);
    } else {
        def.reject();
    }

    return def.promise();
}

// store connection
function storeConnection(id, connection) {
    connections[id] = connection;
}

// close and drop a connection
function dropConnection(id) {
    var connection = connections[id];
    if (connection) {
        connection.expunge('INBOX').always(function () {
            connection.end();
        });
    }
    delete connections[id];
}

module.exports = {
    Connection: Connection,
    getConnection: getConnection,
    getConnectionBySession: getConnectionBySession,
    storeConnection: storeConnection,
    dropConnection: dropConnection
};
