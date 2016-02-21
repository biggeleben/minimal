# Minimal Mail UI

This is a little pet project to play around with imap, node.js, express, and socket.io. Main paradigms are simplicity and performance. Tested with Dovecot so far.

**Setup**

* Clone repository
* npm install (the image lib might be tricky)
* Edit config.js (mail server, port, username, password)
* Run: node index.js or nodemon index.js

**Features**

* It's simple and **fast**
* The mail 101: Show all subscribed mailboxes, show all messages in a mailbox, read a message, access attachments.
* **Push** via IMAP IDLE (works for flag changes and new messages)
* **Themes**! Yep. Simplicity is good but your favorite color is better. Click on the little star icon (top right) to change themes.
* Powerful and fast **search**. Supports different prefixes, e.g. `subject:report from:matthias`. You can use `subject:`, `from:`, `to:`, `cc:`, and `year:`. To search in all mailboxes just add `:all` (leading colon). No support for fulltext because far too slow.
* General HTML **sanitizing**; safe enough to play around
* External images are blocked. Click "Show images" to load them. Smooth replacement; no message-reload necessary.
* Basic keyboard support (tab, cursor up/down)
* Images are **auto-rotated** for proper orientation
* All attached images (JPEG, PNG, BMP, GIF) are auto-added to the message body
* Press `u` key to mark a message as unseen/seen
* Press `backspace` or `del` to delete a message (not yet server-side)

**Architecture**

* Using express to provide a simple REST-y API
  * `GET /folders` Get all subscribed folders/mailboxes
  * `GET /mail/messages/<mailbox>` Get all messages in a mailbox
  * `GET /mail/message/<mailbox>/<uid>` Get a message
  * `GET /mail/attachment/<mailbox>/<uid>/<part>` Get a particular attachment
  * `PUT /mail/search?query=...` Search for messages
  * `PUT /mail/message/<mailbox>/<uid>/flags` Update flag (seen)
* socket.io to handle IMAP IDLE
* Almost all content is rendered server-side (via simple underscore templates)

**Open playgrounds**

* Add login/logout support
* Concurrency

**Limitations**

* Designed for recent browser versions only (primarily Chrome)
* Desktop-only; no responsive stuff
* Dovecot-only
* No i18n; en_US only
* Just very basic keyboard support
* No tests (yet)
