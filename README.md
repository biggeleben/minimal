# minimal
Minimal Mail UI

This is a little pet project to play around with imap, node.js, express, and socket.io. Main paradigms are simplicity and performance. Tested with Dovecot so far.

**Setup**

* Clone repository
* npm install
* Edit config.js (mail server, port, username, password)
* Run: node index.js or nodemon index.js

**Features**

* It's simple and fast
* The mail 101: Show all subscribed mailboxes, show all messages in a mailbox, read a message, access attachments.
* Push via IMAP IDLE (works for flag changes and new messages)
* Themes! Yep. Simplicity is good but your favorite color is better. Hit
* Powerful search. Supports different prefixes, e.g. subject:report from:matthias. You can use subject:, from:, to:, cc:, and year:. To search in all mailboxes just add :all (leading colon). No support for fulltext because far too slow.
* General HTML sanitizing; safe enough to play around
* External images are blocked. Click "Show images" to load them. Smooth replacement; no message-reload necessary.
* Basic keyboard support (tab, cursor up/down)
* Images are auto-rotated for proper orientation
* All attached images (JPEG, PNG, BMP, GIF) are auto-added to the message body
* Press "u" key to mark a message as unseen/seen
* Press <backspace/del> to delete a message (not yet server-side)

**Open playgrounds**

* Add login/logout support
* Concurrency

