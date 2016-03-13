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

// all message content-related stuff

var sanitize = require('sanitize-html'),
    _ = require('underscore');

var messageStyle = '<style> html { overflow-y: hidden; overflow-x: auto; } body { overflow: hidden; font: normal 13px/normal "Helvetica Neue", Helvetica, Arial, sans-serif; padding: 16px; border: 0; margin: 0; max-width: 700px; } ' +
    'a { color: #337ab7; } p { margin: 0 0 1em 0; } blockquote { color: #777; border-left: 1px solid #ccc; margin: 0 0 1em 0; padding-left: 23px; } ' +
    'table { border-collapse: collapse; } pre { white-space: pre-wrap; } .simple-message { word-break: break-word; } ' +
    '.simple-message img { max-width: 100%; height: auto; border: 0; } .simple-message img.injected { margin: 1em 0 0 0; } ' +
    'img[src="//:0"] { background-color: rgba(0, 0, 0, 0.1); background-image: repeating-linear-gradient(45deg, rgba(0, 0, 0, 0), rgba(0, 0, 0, 0) 20px, rgba(255, 255, 255, 0.5) 20px, rgba(255, 255, 255, 0.5) 40px); ' +
    '</style>';

module.exports = {

    assemble: function (contentParts, data) {

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
    },

    sanitize: function (data) {

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
                // LINKS
                'a': function (tagName, attribs) {
                    attribs.target = '_blank';
                    return { tagName: 'a', attribs: attribs };
                },
                // IMAGES
                'img': function (tagName, attribs) {
                    var src = String(attribs.src || '').trim(), match;
                    if (/^(https?\:)?\/\//i.test(src)) {
                        // block external images
                        data.blockedImages = true;
                        attribs.src = '//:0';
                        attribs['data-original-src'] = src;
                    } else if ((match = src.match(/^cid\:(.+)$/i))) {
                        // set proper URL for inline images
                        attribs.src = 'mail/messages/' + data.folder + '/' + data.id + '.' + data.hash[match[1]];
                    }
                    return { tagName: 'img', attribs: attribs };
                }
            },
            textFilter: function (escaped, parents) {
                // plain text message don't have parents yet (i.e. no <p> or <body>)
                if (parents.length === 0 || parents[0].tag !== 'a') {
                    // detect URLs unless already within <a>
                    escaped = escaped.replace(/((?:(?:https?\:\/\/)|www\.).*?)(\s|([.,;!?](\s|$))|$)/g, '<a href="$1" target="_blank">$1</a>$2');
                    // detech mail address (use indexOf as a quick check)
                    if (escaped.indexOf('@') > -1) {
                        escaped = escaped.replace(/([^"\s<,:;\(\)\[\]\u0100-\uFFFF]+@([a-z0-9äöüß\-]+\.)+[a-z]{2,})/g, '<a href="mailto:$1" target="_blank">$1</a>');
                    }
                }
                return escaped;
            }
        });
    },

    addStructure: function (data) {
        if (data.contentType === 'text/plain') data.content = '<body>' + data.content + '</body>';
        data.content = '<!doctype html><html><head><meta charset="utf-8"></head>' + data.content + '</html>';
        // mark as simple?
        if (!/<table/i.test(data.content)) data.content = data.content.replace(/<html/, '<html class="simple-message"');
        // inject missing <head>
        if (!/<head>/i.test(data.content)) data.content = data.content.replace(/(<html[^>]*>)/, '$1<head></head>');
        // inject css
        data.content = data.content.replace(/<head>/, '<head>' + messageStyle);
    },

    removeLeadingWhiteSpace: function (data) {
        data.content = data.content.replace(/(<body[^>]*>)(\s+|<p>\s*(<br[^>]*>)*\s*<\/p>|<br[^>]*>)+/gi, '$1');
    },

    cleanUpText: function (str) {
        // escape special chars
        return _.escape(String(str || '').trim())
            // beautify quotes
            .replace(/(\r?\n&gt;.*)+/g, function (str) {
                return '\n<blockquote type="cite">' + str.replace(/\r?\n&gt;[ ]*/g, '\n') + '\n</blockquote>';
            })
            // inject <br> into plain text
            .replace(/\r?\n/g, '<br>');
    },

    isHTML: function (parts) {
        return !!_(parts).find(function (part) { return part.contentType === 'text/html'; });
    },

    getMimeParts: function (parts) {
        return _(parts)
            .chain()
            .filter(function (part) { return part.contentType.indexOf('text') === 0; })
            .pluck('id')
            .value();
    },

    getContentParts: function (parts, folder, uid) {
        var html = this.isHTML(parts), append = false, result = [];
        _(parts).each(function (part) {
            // always attach common image types; ignore disposition but check "cid";
            // having a cid is an indicator that it's a references inline image anyway
            if ((append || !html) && /^image\/(jpe?g|png|bmp|gif)$/i.test(part.contentType) && !part.cid) {
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
    },

    // hash to map cid to part ID
    getPartsHash: function (parts) {
        var hash = {};
        _(parts).each(function (part) {
            if (part.cid) hash[part.cid.replace(/^<|>$/g, '')] = part.id;
        });
        return hash;
    }
};
