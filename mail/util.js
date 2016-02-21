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

var _ = require('underscore'),
    moment = require('moment'),
    now = +moment();

module.exports = {

    getWho: function (list) {
        return _(list)
            .map(function (item) {
                return item.name || item.address || '\x20';
            })
            .join(', ');
    },

    getDate: function (t) {
        var m = moment(t);
        return m.isSame(now, 'd') ? m.format('LT') : m.format('l');
    },

    getFullDate: function (t) {
        return moment(t).format('l LT');
    },

    getFlagClasses: function (data) {
        var classes = [];
        if (data.flags.deleted) classes.push('deleted');
        if (!data.flags.seen) classes.push('unseen');
        return classes.join(' ');
    }
};
