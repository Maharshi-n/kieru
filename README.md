# Kieru

[kieru.maharshinahar.in](https://kieru.maharshinahar.in)

A live-only session app for exactly two people. You and one friend enter a room
together and get chat, a shared whiteboard, file transfer, screen share and a voice
call in a single screen. When either of you leaves, everything is gone.

Nothing is ever stored. There is no message history, no file sitting on a server, no
saved whiteboard. That is the point — leave no trace.

## How it works

Everything you actually send goes browser-to-browser over WebRTC. Chat, strokes, files
and control messages ride one PeerJS data connection as typed JSON; voice and screen
share are separate media connections, so starting or ending a share never disturbs the
call.

The server is deliberately dumb. It knows accounts, who is friends with whom, who is
currently online, and each online person's temporary peer ID — nothing else. It never
sees a message, a file, or a pixel of the whiteboard. Peer IDs are random per login and
presence is a heartbeat, so identity on the wire is disposable.

Signaling runs on the PeerJS public cloud. When a direct connection can't be made —
Indian mobile networks behind CGNAT fail roughly one time in seven — traffic falls back
to a TURN relay so the session still works.

## What's in a session

- **Chat** — plain text, live only, gone on exit
- **Whiteboard** — shared canvas, pen and colour and width, clear and undo
- **Files** — offered, accepted, then streamed in chunks straight to disk, with progress on both sides
- **Screen share** — its own stream, independent of the voice call
- **Voice** — one-tap call with mute and hang-up; hanging up doesn't end the session

Relayed connections carry a daily allowance (file transfer and screen-share minutes)
because relay bandwidth isn't free. Direct connections are unlimited, which is most of
them.

## Sign-in and friends

Google Sign-In only, no passwords. You add friends by email, they accept, and after that
you can see when they're online and start a session. Both people have to have the tab
open — there's no ringing someone who isn't there, and no offline delivery.

## Deliberately not here

Message history, group sessions, video calls, push notifications, file transfer resume.
Every one of those pulls toward storing things or growing past two people, and this app
is built to do neither.
