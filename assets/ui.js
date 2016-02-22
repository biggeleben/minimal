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
        style = '<style> html, body { overflow: hidden; } body { font: normal 13px/normal "Helvetica Neue", Helvetica, Arial, sans-serif; padding: 16px; border: 0; margin: 0; max-width: 700px; } ' +
            'a { color: #007dbc; } p { margin: 0 0 1em 0; } blockquote { color: #777; border-left: 1px solid #ccc; margin: 0 0 1em 0; padding-left: 23px; } ' +
            'table { border-collapse: collapse; } pre { white-space: pre-wrap; } .simple-message { word-break: break-word; } ' +
            '.simple-message img { max-width: 100%; height: auto; border: 0; } .simple-message img.injected { margin: 1em 0 0 0; } ' +
            'img[src="//:0"] { background-color: rgba(0, 0, 0, 0.1); background-image: repeating-linear-gradient(45deg, rgba(0, 0, 0, 0), rgba(0, 0, 0, 0) 20px, rgba(255, 255, 255, 0.5) 20px, rgba(255, 255, 255, 0.5) 40px); ' +
            '</style>',
        labels = { from: 'From', to: 'To', cc: 'Copy', bcc: 'Blind copy' },
        slice = Array.prototype.slice,
        tick,
        // main views
        folderView = $('.folder-view'),
        listView = $('.list-view'),
        detailView = $('.detail-view');

    // Main stuff

    function setFolder(folder) {
        currentFolder = folder;
        location.hash = '#' + escape(folder);
    }

    function loadFolders() {
        return $.ajax({ url: 'mail/mailboxes' }).then(function (html) {
            folderView[0].innerHTML = html;
            folderView.find('[data-cid="' + $.escape(currentFolder) + '"]').focus();
            return html;
        });
    }

    function fetchMailbox(folder) {
        if (folder === undefined) folder = currentFolder; else setFolder(folder);
        clearSearchField();
        var busy = setTimeout(function () { listView.addClass('busy'); }, 500);
        var render = lastOneWins(renderMessages);
        return $.ajax({ url: 'mail/messages/' + folder + '/' })
            .always(function () {
                clearTimeout(busy);
                listView.removeClass('busy');
            })
            .done(function (data) {
                render(data);
            });
    }

    function searchMessages(query) {
        clearMailbox();
        listView.addClass('busy');
        var url = 'mail/messages/' + currentFolder + '/?' + $.param({ query: query });
        return $.ajax({ method: 'search', url: url }).done(lastOneWins(renderMessages));
    }

    function renderMessages(html) {
        listView.removeClass('busy').scrollTop(0).get(0).innerHTML = html;
        clearDetailView();
    }

    var pending = null;

    function fetchMessage(cid) {
        if (messageCache[cid]) {
            toggleSeenIfUnseen(cid);
            return renderMessage(messageCache[cid]);
        }
        var fade = setTimeout(function () { detailView.addClass('fade'); }, 300);
        var busy = setTimeout(function () { detailView.addClass('busy'); }, 600);
        var render = lastOneWins(renderMessage);
        if (pending) pending.abort();
        pending = $.ajax({ url: 'mail/messages/' + cid });
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

        detailView.append(
            $('<header>').append(
                // SUBJECT
                $('<h1 class="subject">').text(data.subject || 'No subject'),
                // DATE
                $('<time class="received-date">').text(data.dateFullStr),
                // FROM, TO, CC, BCC
                ['from', 'to', 'cc', 'bcc'].map(function (id) {
                    return data[id].length ? $('<dl class="addresses">').append(
                        $('<dt>').text(labels[id]),
                        $('<dd>').text(getAddresses(data[id]))
                    ) : [];
                }),
                // ATTACHMENTS
                data.attachments.parts ?
                    $('<dl class="attachments">').append(
                        $('<dt>').attr('aria-label', 'Attachments').append('<i class="icon-paperclip">'),
                        $('<dd>').append(getAttachments(data.cid, data.attachments.parts))
                    ) : []
            ),
            // BLOCKED IMAGES
            data.blockedImages ?
                $('<section class="blocked-images">').append(
                    $('<button class="unblock-images">').text('Show images'),
                    text('Some external images have been blocked to protect your privacy')
                ) : [],
            // SPAM
            data.flags.spam ? $('<section class="spam">').text('This message is marked as spam!') : [],
            // CONTENT
            $('<iframe src="//:0">')
        );
        var iframe = $('.detail-view iframe'),
            doc = iframe.prop('contentDocument'),
            html = data.content;
        // mark as simple?
        if (!/<table/i.test(html)) html = html.replace(/<html/, '<html class="simple-message"');
        // inject missing <head>
        if (!/<head>/i.test(html)) html = html.replace(/(<html[^>]*>)/, '$1<head></head>');
        // test xss
        iframe.prop('contentWindow').xss = xss;
        // inject css
        html = html.replace(/<head>/, '<head>' + style);
        doc.open();
        doc.write(html);
        doc.close();
        // resize
        resize();
        tick = setInterval(resize, 300);
        return data;
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

    function getAddresses(list) {
        return list
            .map(function (item) {
                return String(item.name || item.address).replace(/\s/g, '\u00A0');
            })
            .join(',\u00a0\u00a0 ');
    }

    function getAttachments(cid, list) {
        return list.map(function (item) {
            return $('<a>')
                .attr({
                    'href': 'mail/messages/' + cid + '.' + item.id,
                    'target': '_blank'
                })
                .text(item.filename.replace(/\s/g, '\u00A0'))
                .add(text('\u00A0\u00A0 '));
        });
    }

    function clearMailbox() {
        $('.list-view').prop('innerHTML', '');
        clearDetailView();
    }

    function clearDetailView() {
        clearInterval(tick);
        $('.detail-view').scrollTop(0).prop('innerHTML', '');
    }

    function clearSearchField() {
        $('.search-field').val('');
    }

    function focusListView() {
        $('.list-view').children().first().focus();
    }

    function toggleSeen(cid, state) {
        var node = listView.find('[data-cid="' + $.escape(cid) + '"]');
        if (state === undefined) state = node.hasClass('unseen');
        node.toggleClass('unseen', !state);
        $.ajax({ method: 'put', url: 'mail/message/' + cid + '/flags?seen=' + state });
    }

    function toggleSeenIfUnseen(cid) {
        var node = listView.find('[data-cid="' + $.escape(cid) + '"]');
        if (node.hasClass('unseen')) toggleSeen(cid, true);
    }

    function removeMessage(cid) {
        var node = listView.find('[data-cid="' + $.escape(cid) + '"]');
        node.next().focus();
        node.remove();
    }

    // built-in xss check
    window.xss = function (n) {
        xss.count = (xss.count || 0) + 1;
        detailView.prepend($('<h1 style="color: white; display: inline-block">').text('XSS.' + xss.count + '.' + n + '\u00a0 '));
    };

    // init
    loadFolders();
    fetchMailbox(currentFolder);

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

    $(document).on('focus', '.folder-view .folder', function (e) {
        if (e.isDefaultPrevented()) return; else e.preventDefault();
        var cid = $(e.currentTarget).attr('data-cid');
        if (cid) fetchMailbox(cid);
    });

    $(document).on('keydown', '.folder-view .folder', function (e) {
        var down = e.which === 40, up = e.which === 38;
        if (!(down || up) || e.isDefaultPrevented()) return;
        e.preventDefault();
        var all = $('.folder-view .folder:visible'), index = all.index(document.activeElement);
        index += down ? +1 : -1;
        if (index < 0 || index >= all.length) return;
        all.eq(index).focus();
    });

    $(document).on('keydown', '.folder-view .folder', function (e) {
        var left = e.which === 37, right = e.which === 39;
        if (!(left || right) || e.isDefaultPrevented()) return;
        e.preventDefault();
        $(e.currentTarget).children('.subfolders').toggle(!!right);
    });

    $(document).on('focus', '.list-view li', function (e) {
        if (e.isDefaultPrevented()) return; else e.preventDefault();
        var cid = $(e.currentTarget).attr('data-cid');
        if (cid) fetchMessage(cid);
    });

    $(document).on('keydown', '.list-view li', function (e) {
        var down = e.which === 40, up = e.which === 38;
        if (!(down || up)) return;
        e.preventDefault();
        $(e.currentTarget)[down ? 'next' : 'prev']().focus();
    });

    // 'u' -> mark unseen/seen
    $(document).on('keydown', '.list-view li', function (e) {
        if (e.which !== 85) return;
        var cid = $(e.currentTarget).attr('data-cid');
        toggleSeen(cid);
    });

    // <backspace/del> -> delete message
    $(document).on('keydown', '.list-view li', function (e) {
        if (!(e.which === 8 || e.which === 46)) return;
        // preventDefault to avoid history back
        e.preventDefault();
        var cid = $(e.currentTarget).attr('data-cid');
        removeMessage(cid);
    });

    // Theme switch
    $(document).on('click', '.theme-switch', function () {
        nextTheme();
    });

    // Logout
    $(document).on('click', '.logout', function () {
        location.reload();
    });

    // unblock images
    $(document).on('click', '.unblock-images', function () {
        detailView.find('.blocked-images').remove();
        var doc = detailView.find('iframe').prop('contentDocument');
        $(doc).find('img[src="//:0"').each(function () {
            var original = this.getAttribute('data-original-src');
            if (!original) return;
            this.setAttribute('src', original);
            this.removeAttribute('data-original-src');
        });
    });

    // Socket support
    var socket = window.socket = io.connect('//' + location.host);
    socket.on('update', function (data) {
        console.log('socket:update', data)
        if (!data.flags) return;
        listView.children('[data-seqno="' + data.seqno + '"]')
            .toggleClass('unseen', !data.flags.seen)
            .toggleClass('deleted', data.flags.deleted);
    });
    socket.on('uidvalidity', function (data) {
        console.log('socket:uidvalidity', data)
    });
    // ignore first event right after page reload
    var first = true;
    socket.on('mail', function (data) {
        if (first) { first = false; return; }
        console.log('socket:mail', data);
        fetchMailbox();
        // new Audio('assets/beep.mp3').play();
    });
});

//
// Util
//

$.escape = function (str) {
    // escape !"#$%&'()*+,./:;<=>?@[\]^`{|}~
    // see http://api.jquery.com/category/selectors/
    return String(str).replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
};
