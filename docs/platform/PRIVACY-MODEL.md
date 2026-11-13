# Privacy model of the racing data

What other people can see of a driver, what they never can, and what a driver can take or erase. The API is in `API-V1.md` (social side);
the checks are `npm run test:sim-social`. The owner's decisions: **profiles are public by default**; each driver chooses `public`,
`friends` or `private` and can change it at any time; a driver can add friends, block people, and share single laps or sessions by link.

## Identity: who anybody is

A driver is a `handle` (3 to 24 characters of `a-z0-9_`) and a `displayName` (1 to 40 characters). Both are **generated** the first time the
person uses the Virtual API (a read of their profile, or their first uploaded lap): `driver_k7f2q9` and `Driver K7F2`, from random letters
and digits with no look-alikes. Nothing is ever derived from the account's e-mail, phone number or real name. The driver may change them:
the handle 3 times in 30 days (reserved words like `admin`, `xpeed...`, `support`, `moderator...` are refused), the name any time (no control or invisible
characters, and nothing that looks like an e-mail address).

## What is public by default, and what never is

| | Who can see it |
|---|---|
| Handle, display name, "joined" date, games played, number of personal bests, five most recent personal bests, the driver's rows on a public leaderboard | anyone signed in, while the profile is `public` (the default) |
| The same, to accepted friends only | when the profile is `friends` |
| The same, to nobody | when the profile is `private` (no page, no leaderboard row, not found by handle) |
| A lap or session the driver shared by link | whoever holds the link, signed in or not, until it expires or is revoked; the driver's name and handle go with it unless the profile is `private` |
| **E-mail, phone number, real name, sign-in id, account id, device names and keys, which laps exist beyond the best per track and car, lap files, sessions, track layouts, storage, friends list, who blocked whom, who reported whom** | **nobody but the driver** (and moderators see reports and lap numbers, with handles and names only, never an e-mail) |

Lap files are only ever downloaded by their owner (`GET /laps/<id>/file`) and through a share link that covers that lap. A leaderboard row
gives the time, not the file.

## The visibility matrix, as implemented

Viewer relative to the driver; "friend" is an accepted friendship; **blocked** is a block in either direction; a **hidden** profile (moderation) is treated like a
blocked one by everybody except the owner, who sees their own data as usual.

| Viewer asks | `public` | `friends` | `private` |
|---|---|---|---|
| profile page | owner, friend, stranger: yes; blocked: 404 | owner, friend: yes; stranger, blocked: 404 | owner: yes; everybody else: 404 |
| row on the public leaderboard | yes (not for blocked viewers) | no | no |
| row on the friends leaderboard of a friend | yes | yes | no |
| own row on the friends leaderboard | yes | yes | yes |
| friend request by handle from a stranger | accepted as a request | accepted as a request | `404 handle_not_found`, identical to an unknown handle |
| display name in a friend's list | shown | shown | `null` (the handle stays, so the friendship can be removed) |
| report the profile or its laps | allowed | only if the reporter could see it | `404 target_not_found` |
| share link the driver made | summary with name | summary with name | summary without the driver |

Two rules keep the matrix from leaking: a private, hidden, blocked or unknown handle always gets the same answer (same status, same body), and a block is never
announced to the blocked person (they see the same "not found" as for a handle nobody has).

## Friends

Requests are made by handle; the other person accepts or declines (a decline deletes the request, so nothing is recorded against the asker); either side can remove a
friendship or withdraw a request; a **block** replaces whatever there was, hides each person from the other (profile, boards, requests, lists), and stops requests. At most 200
friends and 50 requests waiting per person; two requests that cross become a friendship. The block is kept by the blocker and lifted only by them.

## What counts for a ranking

Only a lap that is `valid` (the game's own verdict), `plausible` (the server's checks on the file: sectors add up to the lap time within 50 ms; the clock of the file matches the lap
time within 0.5 %; the distance matches the track within 3 %; no speed above 150 m/s or below 0; a sample rate and count that fit the lap time; no gap in the clock above 2 s) and not
`hidden` by a moderator, of a driver whose profile allows it. A lap that fails is still kept for its driver; it just does not rank. The failed checks (with the numbers) are kept for moderators.

## Moderation

Anybody can report a profile or a lap (one open report per reporter and target, 10 an hour) and only what they could see. Moderators (the app's existing admin check) can dismiss
a report, action it, and **hide** the profile or the lap: a hidden item is in no social answer (boards, pages, friend lists, requests, shares, reports). The driver keeps their own data. A moderator
can show it again.

## Your rights (LGPD)

- **Access and portability: `GET /me/export`.** One JSON file with the profile, friends by handle, sessions, laps, personal bests, devices, share links, track layouts and the reports the person made,
  plus a link for each lap file and track layout file. No e-mail of anyone, no device key, no share token, nothing of another person.
- **Erasure: `DELETE /me/data` with `{"confirm":"delete my racing data"}`.** Deletes, in one transaction, the laps, sessions, personal bests, track layouts, share links, friendships (both sides),
  the reports the person made and the reports about them, the handle history, the profile, the devices (their keys stop working) and the pairing codes, then removes the lap files and track files.
  The account itself is **not** deleted. After it nothing of the person is reachable or listed: their handle is a 404, their links are 404, they are on no board and in nobody's friend list.
- **Correction and visibility:** `PATCH /profile` at any time.

## Known limits

- A person who deletes their data and signs in again gets a new, generated profile; a moderator's `hidden` on the old one is gone with it. (Keeping a tombstone would keep personal data after an erasure request; this is a decision for the owner.)
- The export is built in one query and one response: fine for a person with thousands of laps, to be streamed if one ever has hundreds of thousands.
- Laps that arrived before the plausibility check have no verdict and rank nowhere until `POST /admin/recheck` has read them.
- A public driver page and the leaderboards need a signed-in visitor; only share links are open to people who are not signed in.
