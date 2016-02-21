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

var imap = require('./mail/imap'),
    util = require('./mail/util'),
    $ = require('jquery-deferred'),
    _ = require('underscore'),
    sharp = require('sharp');

//
// Express stuff
//

var express = require('express'),
    compress = require('compression'),
    cookieParser = require('cookie-parser'),
    session = require('express-session'),
    app = express();

app.use(compress());
app.use('/assets', express.static('assets'));
app.use(cookieParser());
//app.use(session({ secret: 'super_secure' }));

//
// Main UI
//

app.get('/', function (req, res) {
    res.sendFile(__dirname + '/assets/index.html');
});

//
// All folders
//

app.get('/folders', function (req, res) {

    var tmpl = _.template(
        '<li class="folder" role="treeitem" tabindex="-1" data-cid="<%- data.cid %>">' +
        '  <div class="folder-title" style="padding-left: <%- 16 + data.level * 32 %>px;"><%- data.title %></div>' +
        '  <ul class="subfolders" role="tree">' +
        '  <% _(data.subfolders).each(function (data) { %>' +
        '  <%= tmpl({ data: data, tmpl: tmpl }) %>' +
        '  <% }); %>' +
        '  </ul>' +
        '</li>'
    );

    imap.fetchMailboxes()
        .done(function (data) {
            if (req.query.json) {
                res.type('text').send(JSON.stringify(data, null, 4));
            } else {
                res.send(tmpl({ data: data, tmpl: tmpl }));
            }
        })
        .fail(function (error) {
            res.type('text').json({ error: error });
        });
});

//
// All messages in a folder
//

var tmplEnvelope = _.template(
    '<% _(list).each(function (data) { %>' +
    '<li role="option" tabindex="-1" data-cid="<%- data.cid %>" data-seqno="<%- data.seqno %>" class="<%= util.getFlagClasses(data) %>">' +
    '<div class="row">' +
    '  <time class="date gray"><%- util.getDate(data.date) %></time>' +
    '  <div class="who ellipsis"><%- util.getWho(data.from) %></div>' +
    '</div>' +
    '<div class="row">' +
    '  <% if (data.attachments.heuristic) { %><i class="has-attachment icon-paperclip"></i><% } %>' +
    '  <div class="subject ellipsis gray"><%- data.subject || "No subject" %></div>' +
    '</div>' +
    '</li>\n' +
    '<% }); %>'
);

var tmplError = _.template('<li class="error"><%- error %></li>');

app.get(/^\/mail\/messages\/(.+)$/, function (req, res) {

    imap.fetchEnvelope(req.params[0])
        .done(function (list) {
            if (req.query.json) {
                res.type('json').send(JSON.stringify(list, null, 4));
            } else {
                res.send(tmplEnvelope({ list: list, util: util }));
            }
        })
        .fail(function (error) {
            if (req.query.json) {
                res.type('text').json({ error: error });
            } else {
                res.send(tmplError({ error: error }));
            }
        });
});

app.put(/^\/mail\/search\/(.+)$/, function (req, res) {

    imap.searchEnvelope(req.params[0], req.query.query)
        .done(function (list) {
            if (req.query.json) {
                res.type('json').send(JSON.stringify(list, null, 4));
            } else if (!list || list.length === 0) {
                res.send('<li class="no-matches">No matches</li>');
            } else {
                res.send(tmplEnvelope({ list: list, util: util }));
            }
        })
        .fail(function (error) {
            res.type('text').json({ error: error });
        });
});

//
// A single message
//

app.get(/^\/mail\/message\/(.+)\/(\d+)$/, function (req, res) {

    var folder = req.params[0], uid = req.params[1];
    imap.fetchMessage(folder, uid)
        .done(function (result) {
            res.type('json').send(JSON.stringify(result, null, 4));
        })
        .fail(function (error) {
            res.type('text').json({ error: error });
        });
});

//
// An attachment
//

app.get(/^\/mail\/attachment\/(.+)\/(\d+)\/(\d[\d\.]*)$/, function (req, res) {

    imap.fetchPart(req.params[0], req.params[1], req.params[2])
        .done(function (result) {

            if (req.query.json) {
                result.content = result.content.substr(0, 20) + '...';
                res.type('json').send(JSON.stringify(result, null, 4));
                return;
            }

            if (result.filename) {
                res.set('Content-Disposition', 'inline; filename="' + result.filename + '"');
            }

            if (result.encoding === 'base64') {
                var buffer = new Buffer(result.content, 'base64');
                if (result.contentType === 'image/jpeg') {
                    autoOrientImage(buffer, function (err, buffer) {
                        res.set('Cache-Control', 'private, max-age=864000');
                        res.set('Expires', new Date(Date.now() + 864000000).toUTCString());
                        res.type('image/jpeg').send(buffer);
                    });
                } else {
                    res.type(result.contentType).send(buffer);
                }
            } else {
                res.type(result.contentType).send(result.content);
            }
        })
        .fail(function (error) {
            res.type('text').json({ error: error });
        });
});

// simple rotation; base64 only
function autoOrientImage(buffer, callback) {
    sharp(buffer).rotate().resize(1024).quality(70).toBuffer(callback);
}

//
// Set flag
//

app.put(/^\/mail\/message\/(.+)\/(\d+)\/flags$/, function (req, res) {

    var folder = req.params[0], id = req.params[1];

    imap.selectBox(folder, false).done(function () {
        if (req.query.seen === 'true') imap.connection.addFlags(id, 'Seen'); else imap.connection.delFlags(id, 'Seen');
        res.type('json').json({ state: Boolean(req.query.seen) });
    });
});

//
// Socket stuff
//

var io = require('socket.io').listen(app.listen(1337));

io.sockets.on('connection', function (socket) {
    imap.connection.on('update', function (seqno, info) {
        socket.emit('update', { flags: !!info.flags && imap.getFlags(info.flags), modseq: info.modseq, seqno: seqno });
    });
    imap.connection.on('mail', function (numNewMsgs) {
        socket.emit('mail', { numNewMsgs: numNewMsgs });
    });
    imap.connection.on('uidvalidity', function (uidvalidity) {
        socket.emit('uidvalidity', { uidvalidity: uidvalidity });
    });
});

