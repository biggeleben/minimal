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

    var currentFolder = unescape(location.hash.substr(1) || 'INBOX'),
        messageCache = {},
        slice = Array.prototype.slice,
        tick,
        // main views
        folderView = $('.folder-view'),
        listView = $('.list-view'),
        detailView = $('.detail-view');

    // Login handling

    function showLogin() {
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
        setTimeout(function () { $('form :input').prop('disabled', true); }, 0);
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
        $('#input-user').focus().select();
    };

    window.login_callback = function () {
        $('#input-user, #input-password').val('');
        startApplication();
    };

    $.get('/session').done(startApplication).fail(showLogin);

    // http

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

    window.yell = yell;

    // Main stuff

    var offset = 0, total = 0, LIMIT = 50;

    function setFolder(folder) {
        offset = 0;
        currentFolder = folder;
        location.hash = '#' + escape(folder);
    }

    function loadFolders() {
        return http.GET('mail/mailboxes/').done(function (html) {
            folderView[0].innerHTML = html;
            folderView.find('[data-cid="' + $.escape(currentFolder) + '"]').mousedown();
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
        if (folder === undefined) folder = currentFolder; else setFolder(folder);
        clearSearchField();
        var busy = setTimeout(function () { listView.addClass('busy'); }, 500);
        var render = lastOneWins(renderMessages);
        return http.GET('mail/messages/' + folder + '/?' + $.param({ offset: offset, limit: LIMIT }))
            .always(function () {
                clearTimeout(busy);
                listView.removeClass('busy');
            })
            .done(render);
    }

    function num(n) {
        return String(n).replace(/(\d)(?=(\d{3})+$)/g, '$1,');
    }

    function searchMessages(query) {
        clearMailbox();
        listView.addClass('busy');
        var url = 'mail/messages/' + currentFolder + '/?' + $.param({ query: query, offset: offset, limit: LIMIT });
        return http.SEARCH(url).done(lastOneWins(renderMessages));
    }

    function renderMessages(result) {
        total = result.total;
        var from = offset + 1, to = offset + result.count;
        $('.list-view-toolbar .info').text(
            total > 0 ? num(from) + '\u2013' + num(to) + ' of ' + num(total) : ''
        );
        listView.removeClass('busy').scrollTop(0).get(0).innerHTML = result.html;
        clearDetailView();
    }

    var pending = null, current = null;

    function fetchMessage(cid) {
        if (current === cid) return;
        if (messageCache[cid]) {
            toggleSeenIfUnseen(cid);
            return renderMessage(messageCache[cid]);
        }
        var fade = setTimeout(function () { detailView.addClass('fade'); }, 300);
        var busy = setTimeout(function () { detailView.addClass('busy'); }, 600);
        var render = lastOneWins(renderMessage);
        if (pending) pending.abort();
        pending = http.GET('mail/messages/' + cid);
        pending
            .always(function () {
                pending = null;
                clearTimeout(fade);
                clearTimeout(busy);
                detailView.removeClass('busy fade');
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

    function renderMessage(data) {
        clearDetailView();
        current = data.cid;
        detailView[0].innerHTML = data.content.header;
        var iframe = $('.detail-view iframe'),
            doc = iframe.prop('contentDocument');
        doc.open();
        doc.write(data.content.message);
        doc.close();
        // look for doubleclick
        doc.addEventListener('dblclick', zoomImage, false);
        // test xss
        iframe.prop('contentWindow').xss = xss;
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
        $('.list-view').prop('innerHTML', '');
        clearDetailView();
    }

    function clearDetailView() {
        current = null;
        clearInterval(tick);
        $('.detail-view').scrollTop(0).prop('innerHTML', '');
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

    // Search

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
        if (query === '') fetchMailbox(); else if (query.length === 1) clearMailbox();
    });

    // Cursor navigation

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

    $(document).on('click', '#contextmenu a', function (e) {
        e.preventDefault();
        var item = $(e.currentTarget), name = item.attr('data-cmd'), selection = listView.selection.get();
        if (name && selection.length) cmd(name, selection);
    });

    $(document).on('click', function () {
        $('#contextmenu, #alert').hide();
    });

    // inline actions
    $(document).on('click', '.inline-actions a', function (e) {
        var item = $(e.currentTarget), name = item.attr('data-cmd'), cid = item.closest('.inline-actions').attr('data-cid');
        if (name && cid) cmd(name, cid);
    });

    //
    // Peview
    //

    $('#preview').on({
        show: function () {
            var $el = $(this), images = $el.data('images'), index = (images.length + $el.data('index')) % images.length;
            $el.empty().append(
                    $('<div class="caption">').text((index + 1) + ' / ' + images.length),
                    $('<div class="fa fa-close">'),
                    $('<div class="viewport abs">').css('background-image', 'url("' + images[index] + '")')
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

    // Theme switch
    $(document).on('click', '.theme-switch', function () {
        cmd('change-theme');
    });

    // Logout
    $(document).on('click', '.logout', function () {
        cmd('logout');
    });

    // unblock images
    $(document).on('click', '.unblock-images', function () {
        cmd('unblock-images');
    });

    $('.list-view-toolbar').on('click', '[data-cmd="prev-page"]', function (e) {
        e.preventDefault();
        cmd('prev-page', e.altKey ? 1000 : 50);
    });

    $('.list-view-toolbar').on('click', '[data-cmd="next-page"]', function (e) {
        e.preventDefault();
        cmd('next-page', e.altKey ? 1000 : 50);
    });

    function tbd() {
        yell('Not yet implemented');
    }

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
            node.next().focus();
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

        'cmd:reply': tbd,
        'cmd:reply-all': tbd,
        'cmd:forward': tbd,

        'cmd:preview': function (e, images, index) {
            $('#preview').data({ images: images, index: index }).trigger('show');
        },

        'cmd:prev-page': function (e, limit) {
            offset = Math.max(0, offset - (limit || LIMIT));
            var query = $.trim($('.search-field').val());
            if (query) searchMessages(query); else fetchMailbox();
        },

        'cmd:next-page': function (e, limit) {
            var max = Math.floor((total - 1) / LIMIT) * LIMIT;
            offset = Math.min(max, offset + limit || LIMIT);
            var query = $.trim($('.search-field').val());
            if (query) searchMessages(query); else fetchMailbox();
        }
    });

    function startApplication() {

        $('form').remove();
        $('.app').show();
        loadFolders();
        fetchMailbox(currentFolder);

        // // Socket support
        // var socket = window.socket = io.connect('//' + location.host);
        // socket.on('update', function (data) {
        //     console.log('socket:update', data)
        //     if (!data.flags) return;
        //     listView.children('[data-seqno="' + data.seqno + '"]')
        //         .toggleClass('unseen', !data.flags.seen)
        //         .toggleClass('deleted', data.flags.deleted);
        // });
        // socket.on('uidvalidity', function (data) {
        //     console.log('socket:uidvalidity', data)
        // });
        // // ignore first event right after page reload
        // var first = true;
        // socket.on('mail', function (data) {
        //     if (first) { first = false; return; }
        //     console.log('socket:mail', data);
        //     fetchMailbox();
        //     // new Audio('assets/beep.mp3').play();
        // });
    }
});

//
// Util
//

$.escape = function (str) {
    // escape !"#$%&'()*+,./:;<=>?@[\]^`{|}~
    // see http://api.jquery.com/category/selectors/
    return String(str).replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
};
