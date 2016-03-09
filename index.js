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
    config = require('./config'),
    $ = require('jquery-deferred'),
    _ = require('underscore'),
    gd = require('easy-gd'),
    nodemailer = require('nodemailer');

//
// Express stuff
//

var express = require('express'),
    compress = require('compression'),
    cookieParser = require('cookie-parser'),
    session = require('express-session'),
    RedisStore = require('connect-redis')(session),
    body = require('body-parser'),
    app = express();

app.use(compress());
app.use('/assets', express.static('assets', { maxAge: 86400000 }));
app.use(cookieParser());

var sessionMiddleware = session({
    name: 'minimal.sid',
    store: new RedisStore(),
    secret: 'super_secure',
    resave: true,
    saveUninitialized: true
});

app.use(sessionMiddleware);
app.use(body.urlencoded({ extended: true }));
app.use(body.json());

//
// Main UI
//

app.get('/', function (req, res) {
    res.sendFile(__dirname + '/assets/index.html');
});

//
// Session handling
//

app.get('/session', function (req, res) {

    imap.getConnection(req, res).done(function success() {
        res.type('json').send(JSON.stringify(getSessionData(req), null, 4));
    });
});

app.post('/session', function (req, res) {

    var connection;

    // check if redis is down
    if (!req.session) {
        res.status(500);
        send('login_callback_error', { message: 'Session store is down' });
    } else {
        connection = new imap.Connection(req.body.user, req.body.password);
        connection.promise().done(success).fail(error);
    }

    function success() {
        req.session.user = req.body.user;
        req.session.password = req.body.password;
        imap.storeConnection(req.session.id, connection);
        send('login_callback', getSessionData(req));
    }

    function error() {
        res.status(401);
        send('login_callback_error', { message: 'That didn\'t work' });
    }

    function send(callback, data) {
        res.type('html').send(
            '<!doctype html><html><head></head><body>' +
            '<script>window.parent.' + callback + '(' + JSON.stringify(data) + ');</script>' +
            '</body></html>'
        );
    }
});

app.delete('/session', function (req, res) {
    if (req.session) {
        imap.dropConnection(req.session.id);
        req.session.destroy();
    }
    res.type('json').send('{}');
});

function getSessionData(req) {
    var id = req.session.id,
        user = lc(req.session.user),
        domain = lc(config.domain),
        address = user.indexOf('@') === -1 ? user + '@' + domain : user;
    return { id: id, user: user, address: address };
}

function lc(s) {
    return String(s || '').toLowerCase();
}

//
// All folders
//

app.get('/mail/mailboxes/', function (req, res) {

    var tmpl = _.template(
        '<li class="<%= util.getClass(data) %>" role="treeitem" tabindex="-1" data-cid="<%- data.cid %>">' +
        '  <div class="folder-title" style="padding-left: <%= util.padding(data) %>px;">' +
        '    <%= util.getCaret(data) %><%= util.getIcon(data) %><span><%- data.title %></span>' +
        '    <span class="count"></span>' +
        '  </div>' +
        '  <ul class="subfolders" role="tree">' +
        '  <% _(data.subfolders).each(function (data) { %>' +
        '  <%= util.tmpl({ data: data, util: util }) %>' +
        '  <% }); %>' +
        '  </ul>' +
        '</li>'
    );

    var util = {

        tmpl: tmpl,

        padding: function (data) {
            return 16 + (data.level - 1) * 32;
        },

        getClass: function (data) {
            var classes = ['folder'];
            classes.push(data.special || 'default');
            if (data.id === 'mailboxes') classes.push('open mailboxes');
            return classes.join(' ');
        },

        getCaret: function (data) {
            return data.subfolders.length ? '<i class="fa caret"></i>' : '<i class="fa no-caret"></i>';
        },

        getIcon: function (data) {
            return '<i class="fa icon"></i>';
        }
    };

    imap.getConnection(req, res).done(function (connection) {
        connection.fetchMailboxes()
            .done(function (data) {
                if (req.query.json) {
                    res.type('text').send(JSON.stringify(data, null, 4));
                } else {
                    var html = '';
                    // special use
                    _(data.subfolders).each(function (data) {
                        html += tmpl({ data: data, util: util });
                    });
                    res.send(html);
                }
            })
            .fail(function (error) {
                res.type('text').json({ error: error });
            });
    });
});

app.put('/mail/mailboxes/count', function (req, res) {

    imap.getConnection(req, res).done(function (connection) {
        connection.searchUnseen('INBOX').done(function (result) {
            res.send({ INBOX: result.length });
        });
    });
});

//
// All messages in a folder
//

var tmplEnvelope = _.template(
    '<% _(list).each(function (data, index) { %>' +
    '<li role="option" <%= (index === 0 ? "tabindex=0" : "") %> data-cid="<%- data.cid %>" data-seqno="<%- data.seqno %>" class="<%= util.getFlagClasses(data) %>">' +
    '<div class="row">' +
    '<time class="date gray"><%- util.getDate(data.date) %></time>' +
    '<div class="who ellipsis"><%- util.getWho(data.from) %></div>' +
    '</div>' +
    '<div class="row">' +
    '<% if (data.attachments.heuristic) { %><i class="fa fa-paperclip has-attachment"></i><% } %>' +
    '<% if (data.priority < 3) { %><span class="high-priority">Important</span><% } %>' +
    '<div class="subject ellipsis gray"><%- data.subject || "No subject" %></div>' +
    '</div>' +
    '</li>\n' +
    '<% }); %>'
);

var tmplError = _.template('<li class="error"><%- error %></li>');

app.get(/^\/mail\/messages\/(.+)\/$/, function (req, res) {

    imap.getConnection(req, res).done(function (connection) {
        connection.fetchEnvelope(req.params[0], req.query.offset, req.query.limit)
            .done(function (result) {
                if (req.query.json) {
                    res.type('json').send(JSON.stringify(result, null, 4));
                } else {
                    var count = (result && result.messages.length) || 0;
                    var html = count ? tmplEnvelope({ list: result.messages, util: util }) : '<li class="hint">No messages</li>';
                    res.send({ html: html, count: count, total: result.total });
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
});

app.search(/^\/mail\/messages\/(.+)\/$/, function (req, res) {

    imap.getConnection(req, res).done(function (connection) {
        connection.searchEnvelope(req.params[0], req.query.query, req.query.offset, req.query.limit)
            .done(function (result) {
                if (req.query.json) {
                    res.type('json').send(JSON.stringify(result, null, 4));
                } else {
                    var count = (result && result.messages.length) || 0;
                    var html = count ? tmplEnvelope({ list: result.messages, util: util }) : '<li class="hint">No matches</li>';
                    res.send({ html: html, count: count, total: result.total });
                }
            })
            .fail(function (error) {
                res.type('text').json({ error: error });
            });
    });
});

//
// A single message
//

var tmplMessage = _.template(
    '<header data-cid="<%- data.cid %>">' +
    // SUBJECT
    '<h1 class="subject"><%- data.subject || "No subject" %></h1>' +
    // DATE
    '<time class="received-date"><%- data.dateFullStr %></time>' +
    // FROM, TO, CC, BCC
    '<% ["from", "to", "cc", "bcc"].map(function (id) { %>' +
    '<% if (data[id].length) { %>' +
    '<dl class="addresses">' +
    '<dt><%- util.labels[id] %></dt>' +
    '<dd><%= util.getAddresses(data[id]) %>' +
    '</dl>' +
    '<% } %>' +
    '<% }); %>' +
    // ATTACHMENTS
    '<% if (data.attachments.parts) { %>' +
    '<dl class="attachments">' +
    '<dt aria-label="Attachments"><i class="fa fa-paperclip"></i></dt>' +
    '<dd><%= util.getAttachments(data.cid, data.attachments.parts) %></dd>' +
    '</dl>' +
    '<% } %>' +
    // ACTIONS
    '<div class="inline-actions" data-cid="<%- data.cid %>"><ul role="menu">' +
    '<% [["reply", "Reply"], ["reply-all", "Reply all"], ["forward", "Forward"], ["toggle-seen", "Mark as unseen/seen"], ["delete", "Delete"]].map(function (cmd) { %>' +
    '<li role="presentation"><a href="#" role="menuitem" data-cmd="<%- cmd[0] %>"><%- cmd[1] %></a></li>' +
    '<% }); %>' +
    '</ul></div>' +
    '</header>' +
    // BLOCKED IMAGES
    '<% if (data.blockedImages) { %>' +
    '<section class="blocked-images">' +
    '<button class="unblock-images">Show images</button> ' +
    'Some external images have been blocked to protect your privacy' +
    '</section>' +
    '<% } %>' +
    // SPAM
    '<% if (data.flags.spam) { %>' +
    '<section class="spam">This message is marked as spam!</section>' +
    '<% } %>' +
    // CONTENT
    '<iframe src="//:0"></iframe>'
);

tmplMessage.util = {

    labels: { from: 'From', to: 'To', cc: 'Copy', bcc: 'Blind copy' },

    getAddresses: function (list) {
        return list
            .map(function (item) {
                return '<a href="#" data-cmd="compose-to" data-name="' + _.escape(item.name) + '" title="' + _.escape(item.address) + '">' +
                    _.escape(String(item.name || item.address).replace(/\s/g, '\u00A0')
                ) + '</a>';
            })
            .join(',\u00a0\u00a0 ');
    },

    getAttachments: function (cid, list) {
        return list
            .map(function (item) {
                var filename = item.filename ? '//' + encodeURIComponent(item.filename) : '';
                return '<a href="mail/messages/' + cid + '.' + item.id + filename + '" target="_blank">' +
                    _.escape(item.filename.replace(/\s/g, '\u00A0')) +
                    '</a>';
            })
            .join('\u00a0\u00a0 ');
    }
};

app.get(/^\/mail\/messages\/(.+)\/(\d+)$/, function (req, res) {

    var folder = req.params[0], uid = req.params[1];

    imap.getConnection(req, res).done(function (connection) {
        connection.fetchMessage(folder, uid)
            .done(function (result) {
                result.content = {
                    header: tmplMessage({ data: result, util: tmplMessage.util }),
                    message: result.content
                };
                res.type('json').send(JSON.stringify(result, null, 4));
            })
            .fail(function (error) {
                res.type('text').json({ error: error });
            });
    });
});

//
// An attachment
//

app.get(/^\/mail\/messages\/(.+)\/(\d+)\.(\d[\d\.]*)(\/\/[^\/]+)?$/, function (req, res) {

    imap.getConnection(req, res).done(function (connection) {
        connection.fetchPart(req.params[0], req.params[1], req.params[2])
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
});

// simple rotation; base64 only
function autoOrientImage(buffer, callback) {
    gd.open(buffer).resize({ width: 1024 }).autoOrient().save({ quality: 70 }, callback);
}

//
// Set flag
//

app.put(/^\/mail\/messages\/flags$/, function (req, res) {

    var items = req.body, seen = req.query.seen === 'true';

    imap.getConnection(req, res).then(function (connection) {
        return _(items).reduce(function (def, item) {
            return def.then(function () {
                item = util.cid(item);
                return connection.selectBox(item.folder_id).done(function () {
                    connection.raw()[seen ? 'addFlags' : 'delFlags'](item.id, 'Seen');
                });
            });
        }, $.when());
    })
    .always(function () {
        res.type('json').json({});
    });
});

//
// Delete message
//

app.delete(/^\/mail\/messages\/(.+)\/(\d+)$/, function (req, res) {

    var folder = req.params[0], id = req.params[1];

    imap.getConnection(req, res).done(function (connection) {
        connection.move(folder, [id], 'INBOX/Trash')
            .done(function () {
                res.send({});
            })
            .fail(function (e) {
                res.status(500).send({ message: e });
            });
    });
});

//
// Send new message
//

app.post(/^\/mail\/messages\/$/, function (req, res) {

    // we don't need the connection but the session
    imap.getConnection(req, res).done(function () {

        var transporter = nodemailer.createTransport('smtps://' + req.session.user + ':' + req.session.password + '@' + config.smtp);

        var options = {
            from: req.body.from,
            to: req.body.to || [],
            cc: req.body.cc || [],
            subject: req.body.subject,
            html: req.body.content,
            xMailer: 'Minimal UI v0.1'
        };

        // send mail with defined transport object
        transporter.sendMail(options, function (error, info) {
            if (error) res.status(500).send({ error: error.toString() }); else res.send({});
        });
    });
});

// GO!

var io = app.listen(1337);

//
// Socket stuff
//

io = require('socket.io').listen(io);

// wire with express session
io.use(function(socket, next) {
    sessionMiddleware(socket.request, socket.request.res, next);
});

io.sockets.on('connection', function (socket) {

    var id = socket.request.sessionID, session = socket.request.session;
    imap.getConnectionBySession(id, session).done(function (connection) {
        var imap = connection.raw();
        imap.on('update', function (seqno, info) {
            socket.emit('update', { flags: !!info.flags && connection.getFlags(info.flags), modseq: info.modseq, seqno: seqno });
        });
        imap.on('uidvalidity', function (uidvalidity) {
            socket.emit('uidvalidity', { uidvalidity: uidvalidity });
        });
        imap.on('mail', function (numNewMsgs) {
            socket.emit('mail', { numNewMsgs: numNewMsgs });
        });
    });
});
