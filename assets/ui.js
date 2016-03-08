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

$(function () {

    'use strict';

    // app state
    var state = window.state = {
        folder: unescape(location.hash.substr(1) || 'INBOX'),
        listMode: 'mailbox',
        message: null,
        offset: 0,
        session: {},
        total: 0
    };

    var LIMIT = 50,
        messageCache = {},
        slice = Array.prototype.slice,
        tick,
        // main views
        folderView = $('.folder-view'),
        listView = $('.list-view'),
        detailView = $('.detail-view');

    // ------------------------------------------------------------------------------------------

    //
    // Login handling
    //

    function showLogin() {
        $('body').busy(false);
        $('.login').show();
        $('form').on('submit', onSubmit);
        $('#input-user').focus();
    }

    function onSubmit(e) {
        var form = $('form'), user = $.trim($('#input-user').val()), password = $.trim($('#input-password').val());
        if (user === '' || password === '') {
            showFeedback('Please enter your username and password');
            return e.preventDefault();
        }
        // use timeout; otherwise nothing gets submitted
        setTimeout(function () {
            $('form :input').prop('disabled', true);
            $('.login').hide();
            $('body').busy(true);
        }, 0);
    }

    function showFeedback(message) {
        $('form .login-feedback').text(message).show();
        $(document).one('input', '#input-user, #input-password', function () {
            $('form .login-feedback').hide();
        });
    }

    window.login_callback_error = function (data) {
        showFeedback(data.message);
        $('form :input').prop('disabled', false);
        $('#input-password').val('');
        $('.login').show();
        $('body').busy(false);
        $('#input-user').focus().select();
    };

    window.login_callback = function (data) {
        $('body').busy(false);
        $('#input-user, #input-password').val('');
        startApplication(data);
    };

    $('body').busy();
    $.get('/session').done(startApplication).fail(showLogin);

    // ------------------------------------------------------------------------------------------

    //
    // http layer
    //

    var http = (function () {

        var types = {
            GET: function (url) {
                return $.ajax({ url: url });
            }
        };

        function ajax(method, url, data) {
            return $.ajax({ method: method, url: url, contentType: 'application/json', data: JSON.stringify(data) })
                .then(null, function (xhr) { return JSON.parse(xhr.responseText); });
        }

        ['DELETE', 'PUT', 'POST', 'SEARCH'].forEach(function (type) {
            types[type] = function (url, data) {
                return ajax(type, url, data);
            };
        });

        return types;

    }());

    // yell

    function yell(arg) {
        setTimeout(function () {
            var message = arg && typeof arg === 'object' ? arg.message : arg;
            $('#alert').text(message).show();
        }, 0);
    }

    // ------------------------------------------------------------------------------------------

    //
    // Main stuff
    //

    function setFolder(folder) {
        if (folder !== state.folder) state.offset = 0;
        location.hash = '#' + escape(folder);
    }

    function setListMode(mode) {
        if (mode === state.listMode) return;
        state.offset = 0;
        state.listMode = mode;
    }

    function loadFolders() {
        return http.GET('mail/mailboxes/').done(function (html) {
            folderView.get(0).innerHTML = html;
            folderView.find('[data-cid="' + $.escape(state.folder) + '"]').mousedown();
            loadFolderCount();
        });
    }

    function loadFolderCount() {
        var ids = $('.folder-view')
            .children('.inbox, .drafts, .sent, .spam, .trash, .archive')
            .map(function () { return $(this).attr('data-cid'); })
            .toArray();
        return http.PUT('mail/mailboxes/count', ids).done(function (result) {
            for (var cid in result) {
                $('.folder[data-cid="' + cid + '"] .count').text(result[cid] || '');
            }
        });
    }

    function fetchMailbox(folder) {
        if (folder === undefined) folder = state.folder; else setFolder(folder);
        setListMode('mailbox');
        clearSearchField();
        listView.busy(true, 500);
        var render = lastOneWins(renderMessages);
        return http.GET('mail/messages/' + folder + '/?' + $.param({ offset: state.offset, limit: LIMIT }))
            .always(function () {
                listView.busy(false);
            })
            .done(render);
    }

    function num(n) {
        return String(n).replace(/(\d)(?=(\d{3})+$)/g, '$1,');
    }

    function searchMessages(query) {
        clearMailbox();
        setListMode('search');
        listView.busy(true);
        var url = 'mail/messages/' + state.folder + '/?' + $.param({ query: query, offset: state.offset, limit: LIMIT });
        return http.SEARCH(url).done(lastOneWins(renderMessages));
    }

    function renderMessages(result) {
        state.total = result.total;
        var from = state.offset + 1, to = state.offset + result.count;
        $('.list-view-toolbar .info').text(
            state.total > 0 ? num(from) + '\u2013' + num(to) + ' of ' + num(state.total) : ''
        );
        listView.busy(false).scrollTop(0).get(0).innerHTML = result.html;
        clearDetailView();
    }

    var pending = null;

    function fetchMessage(cid) {
        if (cid === state.message) return;
        if (messageCache[cid]) {
            toggleSeenIfUnseen(cid);
            return renderMessage(messageCache[cid]);
        }
        detailView.busy(true, 300, 'fade');
        detailView.busy(true, 600);
        var render = lastOneWins(renderMessage);
        if (pending) pending.abort();
        pending = http.GET('mail/messages/' + cid);
        pending
            .always(function () {
                pending = null;
                detailView.busy(false).busy(false, null, 'fade');
            })
            .done(function cont(data) {
                messageCache[cid] = data;
                listView.find('[data-cid="' + $.escape(cid) + '"]').removeClass('unseen');
                render(data);
            })
            .fail(function (xhr, textStatus) {
                if (textStatus !== 'abort') clearDetailView();
            });
    }

    function write(iframe, content) {
        var doc = iframe.prop('contentDocument');
        doc.open();
        doc.write(content);
        doc.close();
        // test xss
        iframe.prop('contentWindow').xss = xss;
        return doc;
    }

    function renderMessage(data) {
        clearDetailView();
        state.message = data.cid;
        detailView.get(0).innerHTML = data.content.header;
        var doc = write(detailView.find('iframe'), data.content.message);
        // look for doubleclick
        doc.addEventListener('dblclick', zoomImage, false);
        // resize
        resize();
        tick = setInterval(resize, 300);
        return data;
    }

    function zoomImage(e) {
        var img = e.target;
        if (!img || img.tagName !== 'IMG') return;
        var images = $(this).find('img:not([src="//:0"])'), index = images.index(img);
        cmd('preview', images.map(function () { return this.getAttribute('src'); }).toArray(), index);
    }

    function resize() {
        var iframe = detailView.children('iframe'),
            doc = iframe.prop('contentDocument'),
            outerHeight = detailView.height(),
            headerHeight = detailView.children('header').outerHeight(true);
        if (!doc) return clearInterval(tick);
        var h = Math.max(doc.body.scrollHeight, outerHeight - headerHeight);
        iframe.height(h);
    }

    function text(str) {
        return document.createTextNode(str);
    }

    function lastOneWins() {
        var args = slice.call(arguments),
            fn = args.shift(),
            count = (fn.count = (fn.count || 0) + 1);
        return function () {
            if (count !== fn.count) return;
            fn.apply(fn, args.concat(slice.call(arguments)));
        };
    }

    function clearMailbox() {
        $('.list-view').get(0).innerHTML = '';
        clearDetailView();
    }

    function clearDetailView() {
        state.message = null;
        clearInterval(tick);
        detailView.scrollTop(0).get(0).innerHTML = '';
    }

    function clearSearchField() {
        $('.search-field').val('');
    }

    function focusListView() {
        $('.list-view').children('[tabindex]').focus();
    }

    function toggleSeenIfUnseen(cid) {
        var node = listView.find('[data-cid="' + $.escape(cid) + '"]');
        if (node.hasClass('unseen')) cmd('toggle-seen', [cid], true);
    }

    function cmd(name) {
        var args = Array.prototype.slice.call(arguments, 1);
        $(document).trigger('before:cmd:' + name, args);
        $(document).trigger('cmd:' + name, args);
    }

    // built-in xss check
    window.xss = function (n) {
        xss.count = (xss.count || 0) + 1;
        detailView.prepend($('<h1 style="color: white; display: inline-block">').text('XSS.' + xss.count + '.' + n + '\u00a0 '));
    };

    // ------------------------------------------------------------------------------------------

    //
    // Search
    //

    $(document).on('keydown', '.search-field', function (e) {
        if (e.which === 40) {
            // cursor down
            e.preventDefault();
            return focusListView();
        }
        if (e.which === 27) {
            // escape
            clearSearchField();
            return fetchMailbox();
        }
        if (e.which !== 13) return;
        var query = $.trim($(e.currentTarget).val());
        if (query.length > 1) searchMessages(query);
    });

    // reset list view when empty
    $(document).on('input', '.search-field', function (e) {
        var query = $.trim($(e.currentTarget).val());
        $('.search-close').toggle(query !== '');
        if (query === '') fetchMailbox(); else if (query.length === 1) showSearchSyntax();
    });

    function showSearchSyntax() {
        clearMailbox();
        listView.html(
            '<li class="hint">Hint on syntax:<br><br><b>subject:</b>"some words"<br><b>from:</b>someone<br><b>to</b>:"someone else"<br>' +
            '<b>year:</b>2016<br><b>:all</b> (all mailboxes)<br><b>:unseen</b> (unseen messages only)<br><br>' +
            'If no prefix is given, the string is searched in sender and subject.'
        );
    }

    $(document).on('click', '.search-close', function (e) {
        $('.search-field').val('').trigger('input').focus();
    });

    // ------------------------------------------------------------------------------------------

    //
    // Cursor navigation
    //

    $(document).on('keydown', '.folder-view .folder', function (e) {
        var left = e.which === 37, right = e.which === 39;
        if (!(left || right) || e.isDefaultPrevented()) return;
        e.preventDefault();
        $(e.currentTarget).toggleClass('open', !!right);
    });

    $(document).on('contextmenu', '.list-view li', function (e) {
        e.preventDefault();
        var selection = listView.selection.get(),
            length = selection.length,
            attr = { one: length === 1, some: length >= 1 };
        $('#contextmenu > a').each(function () {
            var req = $(this).attr('data-requires');
            $(this).toggleClass('disabled', req && !attr[req]);
        });
        $('#contextmenu').css({ top: e.pageY - 12, left: e.pageX + 12 }).show();
    });

    $(document).on('click', function () {
        $('#contextmenu, #alert').hide();
    });

    // ------------------------------------------------------------------------------------------

    //
    // Peview
    //

    $('#preview').on({
        show: function () {
            var $el = $(this), images = $el.data('images'), index = (images.length + $el.data('index')) % images.length;
            $el.empty().append(
                    $('<div class="caption">').text((index + 1) + ' / ' + images.length),
                    $('<div class="fa fa-close">'),
                    $('<div class="viewport abs">').append($('<img>', { src: images[index] }))
                )
                .show().focus();
        },
        hide: function () {
            $(this).data({}).empty().hide();
        },
        keydown: function (e) {
            var $el = $(this), index = $el.data('index');
            if (e.which === 27) $el.trigger('hide');
            else if (e.which === 37) $el.data('index', index - 1).trigger('show');
            else if (e.which === 39) $el.data('index', index + 1).trigger('show');
        },
        click: function (e) {
            if ($(e.target).is('.fa-close')) $(this).trigger('hide');
        }
    });

    // ------------------------------------------------------------------------------------------

    //
    // Selection handling list view
    //

    function Selection(view, selector, multiselect) {

        var self = this;

        function getItems(suffix) {
            return view.find(selector + (suffix || ''));
        }

        function clear(items) {
            (items || getItems()).removeClass('selected').removeAttr('tabindex');
        }

        function slice(items, a, b) {
            a = items.index(a);
            b = items.index(b);
            return a <= b ? items.slice(a, b + 1) : items.slice(b, a + 1)
        }

        this.get = function () {
            return getItems('.selected').map(function () { return $(this).attr('data-cid'); }).toArray();
        };

        function trigger() {
            view.trigger('select', [self.get()]);
        }

        view.on('focusin focusout', function (e) {
            $(this).toggleClass('has-focus', $.contains(this, document.activeElement));
        });

        var range = 0;

        view.on('mousedown', 'li', function (e) {
            if (e.isDefaultPrevented()) return; else e.preventDefault();
            var item = $(this), items = getItems(), start, stop;
            if (multiselect && e.shiftKey) {
                // range
                start = items.filter('[tabindex]');
                stop = item;
                clear(start.siblings());
                slice(items, start, stop).addClass('selected');
            } else if (multiselect && (e.ctrlKey || e.metaKey)) {
                // multi
                item.toggleClass('selected');
            } else {
                // single
                // clear items except for right-clicking on a selected item
                if (e.which !== 3 || !item.hasClass('selected')) clear(items);
                item.addClass('selected');
            }
            item.attr('tabindex', 0).focus();
            range = 0;
            trigger();
        });

        // cursor up/down
        view.on('keydown', 'li', function (e) {
            var down = e.which === 40, up = e.which === 38;
            if (!(down || up)) return;
            if (e.isDefaultPrevented()) return; else e.preventDefault();
            var items = getItems(), tab, index;
            // get indexes
            if (multiselect && e.shiftKey) {
                tab = items.filter('[tabindex]');
                index = items.index(tab) + range + (down ? +1 : -1);
                if (index < 0 || index >= items.length) return;
                clear(tab.siblings());
                slice(items, tab, items.eq(index)).addClass('selected');
                range += down ? +1 : -1;
                trigger();
                return;
            }
            // single
            var item = items.filter('.selected' + (down ? ':last' : ':first'));
            index = items.index(item) + (down ? +1 : -1);
            // out of bounds?
            if (index < 0) return view.trigger('above');
            if (index >= items.length) return view.trigger('below');
            clear(items);
            items.eq(index).addClass('selected').attr('tabindex', 0).focus();
            range = 0;
            trigger();
        });
    }

    listView.selection = new Selection(listView, 'li', true);
    folderView.selection = new Selection(folderView, '.folder:visible', false);

    listView.on('select', function (e, list) {
        if (list.length === 1) fetchMessage(list[0]); else clearDetailView();
    });

    listView.on('above', function () {
        $('.search-field').focus();
    });

    folderView.on('select', function (e, list) {
        var cid = list[0];
        if (cid && cid !== 'mailboxes') fetchMailbox(cid);
    });

    $(document).on('mousedown', '.folder-view .fa.caret', function (e) {
        e.preventDefault();
        $(this).closest('.folder').toggleClass('open');
    });

    // 'u' -> mark unseen/seen
    $(document).on('keydown', '.list-view li', function (e) {
        if (e.which !== 85) return;
        var selected = listView.selection.get();
        $(document).trigger('cmd:toggle-seen', [selected]);
    });

    // <backspace/del> -> delete message
    $(document).on('keydown', '.list-view li', function (e) {
        if (!(e.which === 8 || e.which === 46)) return;
        // preventDefault to avoid history back
        e.preventDefault();
        var cid = $(e.currentTarget).attr('data-cid');
        $(document).trigger('cmd:delete', cid);
    });

    // no native context-menu
    $(document).on('contextmenu', false);

    // ------------------------------------------------------------------------------------------

    //
    // forward commands
    //

    $(document).on('click', '[data-cmd]', function (e) {
        e.preventDefault();
        var node = $(e.currentTarget), name = node.attr('data-cmd');
        switch (name) {
            case 'compose':
            case 'change-theme':
            case 'logout':
            case 'unblock-images':
            case 'discard':
                cmd(name);
                break;
            case 'compose-to':
                // todo: add generic solution
                compose('compose', { to: [{ name: node.attr('data-name'), address: node.attr('title') }] });
                break;
            case 'prev-page':
            case 'next-page':
                cmd(name, e.altKey ? 1000 : 50);
                break;
            case 'reply':
            case 'reply-all':
            case 'forward':
                var cid = node.closest('.inline-actions').attr('data-cid') || listView.selection.get()[0];
                if (cid) cmd(name, cid);
                break;
            case 'send':
                yell('Not implemented yet');
                break;
        }
    });

    // ------------------------------------------------------------------------------------------

    //
    // Commands
    //

    $(document).on({

        'cmd:change-theme': function () {
            nextTheme();
        },

        'cmd:logout': function () {
            http.DELETE('/session').done(function () {
                location.reload();
            });
        },

        'cmd:toggle-seen': function (e, cids, state) {
            // use first message to decide
            var node = listView.find('[data-cid="' + $.escape(cids[0]) + '"]');
            if (state === undefined) state = node.hasClass('unseen');
            cids.forEach(function (cid) {
                listView.find('[data-cid="' + $.escape(cid) + '"]').toggleClass('unseen', !state);
            });
            http.PUT('mail/messages/flags?seen=' + state, cids);
        },

        'cmd:delete': function (e, cid) {
            var node = listView.find('[data-cid="' + $.escape(cid) + '"]');
            clearDetailView();
            node.next().trigger('mousedown');
            node.remove();
            http.DELETE('mail/messages/' + cid).fail(yell);
        },

        'cmd:unblock-images': function () {
            detailView.find('.blocked-images').remove();
            var doc = detailView.find('iframe').prop('contentDocument');
            $(doc).find('img[src="//:0"').each(function () {
                var original = this.getAttribute('data-original-src');
                if (!original) return;
                this.setAttribute('src', original);
                this.removeAttribute('data-original-src');
            });
        },

        'cmd:compose': function () {
            compose('compose');
        },

        'cmd:reply': function (e, cid) {
            compose('reply', cid);
        },

        'cmd:reply-all': function (e, cid) {
            compose('reply-all', cid);
        },

        'cmd:forward': function (e, cid) {
            compose('forward', cid);
        },

        'cmd:discard': function () {
            discard();
        },

        'cmd:preview': function (e, images, index) {
            $('#preview').data({ images: images, index: index }).trigger('show');
        },

        'cmd:prev-page': function (e, limit) {
            state.offset = Math.max(0, state.offset - (limit || LIMIT));
            var query = $.trim($('.search-field').val());
            if (query) searchMessages(query); else fetchMailbox();
        },

        'cmd:next-page': function (e, limit) {
            var max = Math.floor((state.total - 1) / LIMIT) * LIMIT;
            state.offset = Math.min(max, state.offset + limit || LIMIT);
            var query = $.trim($('.search-field').val());
            if (query) searchMessages(query); else fetchMailbox();
        }
    });

    // ------------------------------------------------------------------------------------------

    //
    // Compose
    // arg: cid or data

    function compose(mode, arg) {

        var isCompose = mode === 'compose',
            isReply = mode === 'reply',
            isReplyAll = mode === 'reply-all',
            isForward = mode === 'forward';

        function prefix() {
            if (isReply || isReplyAll) return 'Re: ';
            if (isForward) return 'Fwd: ';
            return '';
        }

        function flatten(list) {
            return list
                .filter(function (item) {
                    return item.address !== state.session.address;
                })
                .map(function (item) {
                    return item.name ? '"' + item.name + '" <' + item.address + '>' : item.address;
                })
                .join('; ')
        }

        function show(data) {
            var content = '<!doctype html><html><head><style> body { font: normal 13px/normal "Helvetica Neue", Helvetica, Arial, sans-serif; margin: 0; padding: 16px; } </style></head><body></body></html>';
            // use given data
            if (data) {
                // TO & CC
                if (data.to) $('.compose [data-name="to"]').trigger('reset', flatten(data.to));
                if (data.cc) $('.compose [data-name="cc"]').trigger('reset', flatten(data.cc));
                // subject
                if (data.subject) $('.compose [name="subject"]').val(prefix() + data.subject);
                // content
                if (data.content) {
                    content = window.content = data.content.message
                        .replace(/^([\s\S]+<body[^>]*>)/i, '$1<p><br></p><blockquote type="cite">')
                        .replace(/(<\s*\/\s*body[\s\S]+)$/, '</blockquote>$1');
                }
            }
            var doc = write($('.compose .editor'), content);
            $(doc).find('html').css('overflow', 'auto');
            $(doc).find('body').attr('contenteditable', 'true');
            $('.compose').show();
            if (isReply || isReplyAll) $(doc).find('body').focus();
            else $('.compose [data-name="to"] input').focus();
        }

        function prepare(data) {
            // work on copy
            data = JSON.parse(JSON.stringify(data));
            data.cc = [].concat(data.to, data.cc);
            data.to = data.from;
            data.from = [];
            show(data);
        }

        $('[data-name="to"]').tokenfield({ placeholder: 'To' });
        $('[data-name="cc"]').tokenfield({ placeholder: 'Copy' });

        // reset first
        $('.compose [data-name="to"]').trigger('reset', '');
        $('.compose [data-name="cc"]').trigger('reset', '');
        $('.compose [name="subject"]').val('');

        $('.compose').show();
        $('.mail').addClass('background');

        if (isCompose) show(arg);
        else if (messageCache[arg]) prepare(messageCache[arg]);
        else http.GET('mail/messages/' + arg).done(prepare);
    }

    function discard() {
        $('.compose').hide();
        $('.mail').removeClass('background');
    }

    $('.compose').on('keydown', ':input', function (e) {
        if (e.which === 27) return discard();
        if (e.which !== 13) return;
        e.preventDefault();
    });

    $('.compose').on('next', '.tokenfield', function (e) {
        var name = $(e.currentTarget).attr('data-name');
        if (name === 'to') $('.compose [data-name="cc"] input').focus();
        else if (name === 'cc') $('.compose [name="subject"]').focus();
    });

    // ------------------------------------------------------------------------------------------

    // Start session

    function startApplication(data) {

        state.session = data;

        $('body').busy(false);
        $('form').remove();
        $('.mail').show();
        loadFolders();
        fetchMailbox();
        initializeSocket();
    }

    // Socket support

    function initializeSocket() {
        var socket = window.socket = io.connect('//' + location.host);
        socket.on('update', function (data) {
            console.info('socket:update', data)
            if (!data.flags) return;
            listView.children('[data-seqno="' + data.seqno + '"]')
                .toggleClass('unseen', !data.flags.seen)
                .toggleClass('deleted', data.flags.deleted);
        });
        socket.on('uidvalidity', function (data) {
            console.info('socket:uidvalidity', data)
        });
        // new mail events needs some fixes in imap lib first
        // var first = true;
        // socket.on('mail', function (data) {
        //     if (first) { first = false; return; }
        //     console.info('socket:mail', data);
        //     fetchMailbox();
        //     // new Audio('assets/beep.mp3').play();
        // });
    }
});

// ------------------------------------------------------------------------------------------

//
// jQuery Util
//

$.escape = function (str) {
    // escape !"#$%&'()*+,./:;<=>?@[\]^`{|}~
    // see http://api.jquery.com/category/selectors/
    return String(str).replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
};

$.fn.busy = function (state, delay, className) {

    delay = delay || 300;
    className = className || 'busy';

    return this.each(function () {
        clearTimeout($(this).attr('data-timeout-' + className));
        if (state === false) return $(this).removeClass(className).removeAttr('data-timeout-' + className);
        $(this).attr('data-timeout-' + className, setTimeout(function () {
            $(this).addClass(className);
        }.bind(this), delay));
    });
};

// ------------------------------------------------------------------------------------------

//
// Tokenfield
//

function Tokenfield($el, options) {

    // add css class and hidden input field
    $el.addClass('tokenfield').append(
        $('<span class="autosize">'),
        $('<input type="text" class="field" autocorrect="off" spellcheck="false">')
        .attr('placeholder', options.placeholder)
    );

    // capture focus on click on container
    $el.on('click', function (e) {
        if (e.target === $el[0]) $el.find('input').focus();
    });

    $el.on('keydown', 'input', function (e) {
        var $input = $(this), value = $.trim($input.val()), inbetween;
        switch (e.which) {
            // backspace / cursor left
            case 8:
            case 37:
                if (value === '') $input.prev('.token').focus();
                break;
            // enter
            case 13:
                $input.val('');
                // autosize now to avoid flicker
                autosize();
                if (value) {
                    // add token and restore focus after edit
                    inbetween = !$input.is(':last-child');
                    $el.trigger('add', [value, inbetween]);
                    $input.appendTo($el);
                    if (!inbetween) $input.focus();
                } else {
                    $el.trigger('next');
                }
                break;
        }
        // adjust size
        setTimeout(autosize, 0);
    });

    $el.on('keydown', '.token', function (e) {
        var $token = $(e.currentTarget);
        switch (e.which) {
            // backspace
            case 8: e.preventDefault(); $token.next().focus(); $token.remove(); break;
            // cursor left
            case 37: $token.prev('.token').focus(); break;
            // cursor right
            case 39: $token.next().focus(); break;
            // enter
            case 13: $token.trigger('edit'); break;
        }
    });

    $el.on('dblclick', '.token', function (e) {
        $(e.currentTarget).trigger('edit');
    });

    $el.on('edit', '.token', function (e) {
        var $token = $(e.currentTarget);
        $el.find('input').val($token.attr('data-value')).replaceAll($token).focus().select();
        autosize();
    });

    $el.on('add', function (e, str, focus) {
        var field = $el.find('input');
        split(str).forEach(function (value) {
            value = value.trim();
            var match = $.trim(value).match(/^("|')(.*?)(\1)\s+<([^>]+)>$/),
                text = match ? match[2] : value,
                $token = $('<div class="token" tabindex="-1">');
            field.before($token.attr('data-value', value).text(text));
            if (focus) $token.focus();
        });
    });

    $el.on('reset', function (e, str) {
        $el.find('.token').remove();
        $el.trigger('add', str);
    });

    function split(str) {
        // split string by comma and semi-colon but skip such delimiters in quotes
        return String(str || '').trim().match(/('[^']*'|"[^"]*"|[^"',;]+)+/g) || [];
    }

    function autosize() {
        var $input = $el.find('input'), $auto = $el.find('.autosize');
        $auto.text($input.val());
        $input.width($auto.width() + 16);
    }
}

$.fn.tokenfield = function (options) {
    options = options || {};
    return this.each(function () {
        var $el = $(this);
        if ($el.data('tokenfield')) return;
        $el.data('tokenfield', new Tokenfield($el, options));
    });
};
