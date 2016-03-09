
// after you have entered your personal data, just run the following command
// to keep git away from tracking your changes:
// git update-index --assume-unchanged config.js

module.exports = {
    // just the user - no domain part!
    user: 'user',
    password: 'password',
    // default domain (used to build mail addresses: user@domain)
    domain: 'somewhere.tld',
    // imap. just server name; no http://
    host: 'imap.somewhere.tld',
    port: 993,
    // smpt
    smtp: 'smtp.somewhere.tld'
};
