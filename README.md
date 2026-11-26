# Bib Timer

Time a race with iPads. Point an iPad at the finish line and it reads the
runners' bib numbers with its camera, stamps each one with time taken from NTP
time servers, and gives you a CSV list of bibs and times.

- **Reads bibs on the iPad itself**, from live video, using Apple's on-device
  text recognition. No internet connection is needed for reading.
- **NTP time.** Each iPad sets its race clock from NTP servers and shows how
  accurate the sync is, so several iPads (start, splits, finish) agree with one
  another.
- **Virtual finish line.** You draw a line on the video; a bib's time is worked
  out for the moment it crosses that line, not just whenever it was first read.
- **A Mark button** records a time by hand for any runner the camera cannot
  read; you type the number in afterwards.
- **Every result can be checked and corrected.** Each has a small photo of the
  runner, and its number can be edited or the result deleted.
- **Results are saved continuously**, so a flat battery or a crash does not lose
  a race.
- **CSV export**, by AirDrop, Files, Mail or the clipboard.
- **Live results on your scoring computer** (optional). With the iPads online,
  they copy their results to a small website as they record them. The scoring
  computer opens one address and sees every iPad's results combined, or
  downloads them as CSV.

> **Try it before race day.** The timing logic is covered by automated tests and
> the whole app is compiled in CI, but camera reading depends on your set-up:
> the light, the distance, the bibs. Do a dry run with a few people walking and
> running past, and keep a backup timing method for anything that matters.

## Contents

- [What you need](#what-you-need)
- [Putting the app on an iPad](#putting-the-app-on-an-ipad)
- [At the race](#at-the-race)
- [Several iPads](#several-ipads)
- [Live results on your scoring computer](#live-results-on-your-scoring-computer)
- [How accurate is it?](#how-accurate-is-it)
- [The exported file](#the-exported-file)
- [Settings](#settings)
- [If something is not working](#if-something-is-not-working)
- [For developers](#for-developers)

## What you need

- An iPad (or iPhone) running iPadOS / iOS 17 or later. Newer devices scan
  faster.
- An internet connection **at some point before the race** so the iPad can sync
  its clock: Wi-Fi, a phone hotspot or cellular. It does not have to be at the
  venue (see [Time sync](#3-check-the-time-sync)).
- A tripod or clamp. The iPad has to stay still.
- To install: either the free **Swift Playgrounds** app on the iPad itself, or a
  Mac with **Xcode**.

## Putting the app on an iPad

The app is the folder `BibTimer.swiftpm` in this repository. It is a Swift
Playgrounds app project, which both Swift Playgrounds and Xcode can open.

### Option A: on the iPad, with Swift Playgrounds (no Mac needed)

1. Install **Swift Playgrounds** from the App Store on the iPad.
2. In Safari, open this repository on GitHub, tap **Code**, then **Download
   ZIP**.
3. Open the **Files** app, go to **Downloads** and tap the ZIP file to unpack
   it.
4. Open the unpacked folder and tap **BibTimer**. It opens in Swift Playgrounds.
   (If it shows as an ordinary folder instead, move it into the *Playgrounds*
   folder in Files, then open it from inside Swift Playgrounds.)
5. Tap **Run** (▶). Allow camera access when asked.

The app runs full screen from Swift Playgrounds. To use it again later, open the
project in Swift Playgrounds and tap Run. Your races are kept between runs.

### Option B: from a Mac, with Xcode

This installs Bib Timer as an ordinary app with its own icon.

1. Download or clone this repository on the Mac.
2. Double-click `BibTimer.swiftpm` to open it in Xcode (15 or later).
3. Connect the iPad and choose it as the run destination. When Xcode asks about
   signing, pick your Apple ID as the team in the app's settings.
4. Press **Run**.

With a free Apple ID the installed app works for seven days before it has to be
installed again from Xcode; with a paid Apple Developer account, a year.

## At the race

### 1. Position the iPad

Bibs are on the front of the runners, so the camera has to face them.

- Put the iPad **just past the finish line, looking back at the runners coming
  toward it**.
- Mount it **above head height, tilted down**, if you can. From up there it sees
  over the front runners to the ones behind, and bibs move steadily down the
  picture as runners approach, which is what the finish line needs.
- Keep the sun behind the camera where possible. Bibs in deep shadow or with the
  sun behind the runners are hard to read.
- Landscape or portrait both work; landscape covers a wider course.

A bib can be read once its digits are about 1.5 % of the picture height, which
as a rough guide is 4–5 m from the camera without zoom. Zooming in narrows the
view and reaches further. Your dry run will show the real distance for your
bibs and light.

### 2. Aim and adjust

Create a race (the **+** on the first screen) and you are on the timing screen
with live video. Bibs the camera can read are outlined with their number. Tap
**Adjust** (the viewfinder button):

- **Orange dots** move the finish line. Put it where the bibs are in the
  picture at the moment runners cross your real finish line. The arrow shows
  the direction runners cross it; tap **Flip** if it points the wrong way.
- **Blue dots** set the scan zone, the part of the picture that is searched.
  Shrink it to leave out banners, clocks, parked cars and spectators. A smaller
  zone also scans faster.
- The **slider** zooms.

Have someone wearing a bib walk through the finish and watch the outline: white
means read once, yellow means it is being followed, green (while recording)
means its time has been taken.

### 3. Check the time sync

The badge at the top of the panel shows the clock's state.

| Badge | Meaning |
| --- | --- |
| Green, `NTP ±12 ms` | Synced; the clock is within that much of true time. |
| Orange or red, `NTP ±0.6 s` | Synced a long time ago; the possible error has grown. Sync again. |
| Red, `Not synced · iPad clock` | No sync. Times come from the iPad's own clock and are labelled as such. |

Tap the badge for details and a **Sync now** button. The app syncs by itself
when it starts and every few minutes after that.

**No internet at the venue?** Sync before you leave, on Wi-Fi. The sync is kept
while the iPad sleeps and while the app is closed, and is only lost if the iPad
is restarted. It slowly loses accuracy (the app assumes up to 72 ms per hour and
shows it), so sync as late as you can. If a race does get recorded without a
sync, sync afterwards **before restarting the iPad** and use *Race setup →
Correct them from the time server*: the exact times are worked out
retrospectively.

### 4. Optional: start list and start time

Under **⋯ → Race setup**:

- **Start list.** Paste or import a list with one runner per line, bib number
  first (`101, Jane Doe`). Names then appear in the results, and with *Only
  record bibs on the list* switched on the camera ignores every other number it
  sees. This is the single most effective way to keep stray numbers out.
- **Start time.** Tap **Start** on the timing screen at the gun, or type a
  start time in Race setup. Results then show elapsed time as well as time of
  day.

### 5. Record

Tap **Record**. From now on every bib the camera reads is added to the results
with its time. Each bib is recorded once (for races with laps, change this in
Settings).

- **Mark** adds a result at this instant with no number. Use it for any runner
  the camera is not going to read (bib covered, folded, missing) and fill in
  the number afterwards.
- Tap **Stop** when the race is over.

Keep the app on screen while recording. The iPad is kept awake, and the Back
button is hidden until you tap Stop, so the race cannot be left by accident.

### 6. Check and correct

The results list shows the newest first. Tap a result to see its photo, correct
the number or add a note; swipe left to delete it. Things to look for:

- **`?`** : a mark that still needs its number.
- **estimated** : the bib was only read on one side of the line (it was hidden
  as it crossed), so the nearest sighting was used. Usually within a second.
- **duplicate** : two results have the same number; one of them is a misread.
- **iPad clock** : recorded without a sync.

### 7. Export

Tap the share button. Choose **Bib and time** or **All details**, then share or
save the CSV file, or copy it as text to paste into a spreadsheet.

## Several iPads

Each iPad syncs to NTP separately, so they all keep the same time of day.

- Give each one a **station name** in Settings (*Start*, *5 km*, *Finish A*).
  It is written into the detailed export.
- Take the **start time** on one iPad and type it into the others (Race setup),
  or leave it unset and work from time of day.
- Two iPads on the same finish line, at different angles, catch bibs that one
  alone would miss. Export both and combine the files by bib number in a
  spreadsheet, keeping the earlier time for each bib. Or let the results hub
  described next do the combining for you.

## Live results on your scoring computer

This part is optional. Without it, results leave an iPad by export (step 7
above). With it, every iPad copies its results to a small website, the *hub*,
as they are recorded, and the scoring computer reads them from there.

```
iPad (Start)   ─┐
iPad (Finish A) ─┼─ upload ─▶  hub (a website you run)  ─▶  scoring computer
iPad (Finish B) ─┘                                           live page or CSV
```

**The race does not depend on the connection.** Each iPad saves every result on
itself first and uploads afterwards. If the signal drops, uploads simply resume
when it returns; nothing is lost and no time changes. Exporting from the iPad
keeps working whatever happens to the hub.

The hub is the `hub` folder of this repository: one small Node program with no
other parts. It runs on any host that can run a Docker image. These steps use
[Railway](https://railway.com); its menus change from time to time, so a name
may differ slightly from what is written here.

### 1. Put the hub on Railway

1. In Railway, create a **New Project**, choose **Deploy from GitHub repo** and
   pick this repository. Railway builds the hub from the `Dockerfile` in the
   repository; there is nothing to configure for the build.
2. Open the new service's **Variables** and add `HUB_KEY`. Make it a long
   phrase nobody would guess (at least 8 characters; 20 or more is better).
   This is the access key: anyone who has it can see and change the results.
3. In the service's **Settings**, under networking, **generate a domain**. You
   get an address like `https://something.up.railway.app`. If Railway asks
   which port the app listens on, it is the number in the hub's log line
   `[hub] listening on port …` (normally 8080).
4. Recommended: add a **Volume** to the service, mounted at `/data`. Results
   are then kept across restarts. Without one the hub starts empty after every
   restart, and the iPads fill it again by themselves the next time the app is
   open and online.
5. Open the address in a browser on the scoring computer and enter the key.
   The page says no results have arrived yet.

A second variable, `HUB_VIEW_KEY`, is optional: a key that can look at results
but not change them, for an announcer or a results screen.

### 2. Point the iPads at it

On every iPad:

1. **Settings → Live results**: enter the address and the access key, then tap
   **Connect**. The iPad starts using them once the hub has answered and
   accepted the key; until then nothing changes, so a mistyped address or key
   cannot interrupt uploads that already work.
2. **Settings → Station name**: give each iPad its own (*Start*, *Finish A*).
3. **⋯ → Race setup → Live results**: check the **event code**. Every iPad at
   the event must show the same one, because that is how their results are
   combined. iPads on which the race was created with the same name on the same
   day already agree; otherwise edit the code on one of them to match. (A
   second race with the same name on the same iPad and day gets a code ending
   in `-2`, so that it can never overwrite the first.)

A badge next to the clock badge shows the state: **Shared** (everything is on
the hub), **Sending 3** (three results still to go) or **Not sent yet** (no
connection at the moment; it keeps trying).

### 3. On the scoring computer

The hub's page lists the results of all iPads in order, updating every couple
of seconds. You can hide a station, show one row per bib (the earliest, useful
with two iPads on the same line), and download the CSV. Each station shows when
it was last heard from; an iPad checks in every 45 seconds even when nothing is
happening, so a station that has been silent for a few minutes has lost its
connection or its app has been closed.

**Each iPad on its own.** Every iPad has a **CSV** button of its own on the
page, which downloads just that iPad's results, whatever else is ticked. The
file is named after the event and the iPad (`spring-run-20261128-finish-a.csv`).
The big **Download CSV** and **Copy CSV link** buttons cover the iPads that are
ticked, so unticking all but one gives that iPad's detailed file or link too.
All of this works while the race is still being recorded: a download is the
results as they stand at that moment. Give the iPads different station names
(*Finish A*, *Finish B*); if two have the same name, the page calls the second
one *Finish (2)* so that they can still be told apart.

To fetch the results from scoring software or a script instead, use the direct
address (the page's **Copy CSV link** button builds it for you):

```
https://YOUR-ADDRESS/api/events/EVENT-CODE/results.csv?key=YOUR-KEY
```

| Add to the address | Effect |
| --- | --- |
| `&format=detailed` | All columns instead of bib, time of day, elapsed and station. |
| `&stations=Finish A` | Only this iPad, or several: `Finish A,Finish B`. |
| `&dedupe=first` | One row per bib: the earliest. |
| `&tz=America/New_York` | Times of day in this time zone (default: the iPads' own). |

The same address ending in `results.json` gives everything as JSON. The key can
also be sent as an `Authorization: Bearer YOUR-KEY` header, which keeps it out
of the address.

`elapsed` is measured from the start time set on an iPad (tap **Start**, or set
it in Race setup). If more than one iPad has a start time, the one set most
recently is used, and the page shows which iPad it came from.

### Sending results straight into RunScore

[RunScore](https://runscore.com) can take results over a TCP connection, one
line of text per result, in its open format:

```
RSBI,214,10:23:45.67,Finish A
```

That is the marker for a bib number, the bib, the time of day and the name of
the timing point. RunScore listens for that connection on the scoring computer
itself, and a website cannot reach into your computer. So the last step is
done by a small program that runs on the scoring computer: it fetches each new
result from the hub and hands it to RunScore.

```
iPads ── upload ─▶ hub ◀─ fetches ── connector ── TCP ─▶ RunScore
                 (Railway)          └──── on the scoring computer ────┘
```

The connector runs in Windows PowerShell, which every Windows computer has.
There is nothing to install.

1. **In RunScore**, set up the timer input for its open format over TCP, give
   it a port (3988 is a common choice) and start it. In the versions of
   RunScore described online this is under *Tools → Initialize → External
   Timer*, which has a TCP box and a port; I could not check that against
   RunScore itself. What matters is that RunScore listens on a TCP port for
   lines that begin with `RSBI`.
2. **On the hub's page**, open **Send results to RunScore**, enter the port,
   and press **Copy the line**. The line contains the key you opened the page
   with; if you set a view key (`HUB_VIEW_KEY`), open the page with that one
   first, since reading is all the connector needs.
3. **On the scoring computer**, open **Windows PowerShell**, paste the line
   and press Enter. Leave the window open during the race.

The window shows what it is doing:

```
10:23:01  Connected to RunScore at 127.0.0.1:3988.
10:23:54  -> RSBI,214,10:23:45.67,Finish A
10:24:03  -> RSBI,87,10:23:54.02,Finish A
```

**Try it first.** *Copy a line that only tests the connection* gives a line
that sends RunScore one made-up result (bib 9999 at the present time) and
stops. If that result shows up in RunScore, the connection and the format are
right. Then do a dry run with an iPad before relying on it: the connector is
tested on Windows against a stand-in that records what it is sent, but it has
not been tried against RunScore itself.

How it behaves:

- **A result is passed on about eight seconds after it is recorded.** The
  camera sometimes corrects a number, or withdraws a misread, while the bib is
  still in view; the wait keeps those out of RunScore. A mark without a number
  is passed on when it gets its number.
- **RunScore cannot be asked to take a result back.** If a result is corrected
  or deleted on an iPad after it was passed on, the corrected one is passed on
  as well and the window shows a line that starts with `NOTE`, saying what to
  take out in RunScore.
- **Nothing is lost when something is closed.** If RunScore is closed, or the
  internet connection drops, the connector waits and then passes on everything
  that was recorded meanwhile. If the connector itself is closed, start it
  again with the same line: it carries on where it stopped. In the rare case
  that RunScore closes at the very moment a result is on its way, that result
  is passed on again afterwards, so RunScore may get it twice but never not at
  all.
- **Two iPads.** By default the results of every iPad go to RunScore, each
  with its own station name as the timing point. Enter a **location name** to
  give every line the same one. With two iPads on one finish line RunScore
  then gets two times for most runners, as it would from a main and a backup
  chip mat. To feed two separate inputs in RunScore, tick one iPad at a time
  on the page and make a line for each port.
- **An iPad that is not synced.** Its results are passed on all the same, and
  the window warns, once, that its times come from the iPad's own clock.
- **A click in the window.** In the classic Windows console a click selects
  text, and Windows then holds the program up until Enter is pressed. The
  connector switches that off for its window. Should the window ever seem
  stuck all the same, click in it and press Enter; nothing is lost meanwhile.
- **Data.** The connector asks the hub to hold each request until there is a
  result, so it adds only about 0.2 MB an hour when nothing is happening
  (worked out from the size of a request, not measured).

Things that can be added to the end of the line:

| Addition | Effect |
| --- | --- |
| `-RunScorePort 3988` | The port RunScore listens on. |
| `-RunScoreHost 192.168.1.20` | RunScore on another computer on the same network (default: this one). |
| `-Location FINISH` | The same timing-point name on every line. |
| `-Decimals 3` | Thousandths of a second; 0 to 3 digits (default 2). |
| `-Time elapsed` | Time since the start set on an iPad instead of time of day. |
| `-Prefix RSCI` | Another marker at the start of each line (default `RSBI`). |
| `-LineEnding LF` | How a line ends: `CRLF` (default), `LF` or `CR`. |
| `-Settle 15` | Wait this many seconds before passing a result on (default 8). |
| `-ResendAll` | Forget what was passed on and pass everything on again, for a fresh start in RunScore. |

If the scoring computer does not allow a pasted line to fetch and run a
program, save the program first: open `https://YOUR-ADDRESS/runscore.ps1` in a
browser, save it, and start it from the folder it is in with the same
settings as in the line:

```
powershell -ExecutionPolicy Bypass -File runscore.ps1 -Hub https://YOUR-ADDRESS -Key YOUR-KEY -EventCode EVENT-CODE -RunScorePort 3988
```

If the connection cannot be used on the day at all, **Download as a RunScore
file** on the same panel gives the results as they stand as a text file of the
same lines, and the CSV downloads work as always.

### What is sent, and keeping it private

Sent: bib numbers, times, how each time was taken, the station name, the race
name and your notes. Not sent: photos, and the names on the start list.

Everything travels over HTTPS, and nothing can be read or written without the
key. Treat the key, and any link that contains it, like a password. To change
it, change `HUB_KEY` on Railway and enter the new one on the iPads.

### How much mobile data it uses

Very little. Only numbers and times are sent, never video or photos. These
figures were measured by playing a simulated race into the real hub over an
encrypted connection, with a program standing in for the iPad and sending what
the app sends, and counting every byte in both directions. They are for **one
iPad with the app open for two hours**:

| Results recorded on that iPad | Data used by that iPad |
| --- | --- |
| 150 | about 0.3 MB |
| 300 | about 0.4 MB |
| 600 | about 0.6 MB |
| 1,000 | about 0.9 MB |
| 2,000 | about 1.5 MB |

So a whole race on three iPads is a megabyte or two: about what a single web
page with pictures uses.

- These are the figures when the connection to the hub stays open between
  uploads. The app keeps it open by checking in every 45 seconds. On a poor
  signal the iPad has to reconnect, which costs more: in the worst case, a new
  connection for every single upload, about five times as much (1.5 MB for 150
  results, 7 MB for 2,000).
- What the pieces cost: a result is about 170 bytes, and the upload that
  carries it just under 1 KB (results that arrive together share one upload).
  A check-in with nothing new is just under 1 KB. Reopening the app during a
  race sends that race again in one go: about 85 KB for 500 results.
- The time sync adds roughly 30 KB an hour (worked out from the size of the
  packets, not measured).
- **Race setup → Live results** shows an estimate of what the iPad's uploads
  have used since the app was opened, so after a dry run you can see the figure
  for your own set-up. It does not count reconnecting.

On the **scoring computer**, opening the live page with 400 results already in
takes about 27 KB. After that the page only fetches what is new: at most about
1 MB an hour while it stays open, and well under 1 KB per result. Downloading
the CSV file of 460 results takes 4 KB.

iPadOS itself can use far more data than all of this, for example by syncing
photos or downloading updates. To stop that on race day, switch on **Low Data
Mode** for the connection the iPads use (*Settings → Cellular → Cellular Data
Options*, or for a hotspot *Settings → Wi-Fi →* ⓘ next to its name). It pauses
the system's own background downloads. Bib Timer does not opt out of working in
Low Data Mode, so its uploads and time sync should carry on; check that in
your dry run.

### Running the hub somewhere else

```
cd hub
HUB_KEY=your-long-key node server.js
```

It needs Node 20 or later and nothing else, listens on `PORT` (8080 unless
set), and keeps its copy of the results in `DATA_DIR` (`hub/data` unless set).
The iPads only talk to it over HTTPS, so put it behind something that provides
that.

## How accurate is it?

**The clock.** On Wi-Fi a sync is usually good to 10–50 ms and the app shows the
actual figure. The figure is a worst case: half the network round trip plus the
server's own stated error. Several servers are asked and one that disagrees with
the rest is ignored.

**The moment.** Every video frame is stamped when the camera captures it, not
when the reading finishes, so slow scanning does not delay a time. With the
finish line, the time is interpolated between the two frames either side of the
crossing. Expect around ±0.1 s when the bib is read on both sides of the line.
Results marked *estimated* can be off by a second or so.

**The reading.** This is the weak point of any camera system, and no setting
makes it perfect.

- A bib that is covered by an arm, folded, pinned at the side, very small in the
  picture, in deep shadow or hidden behind another runner will be missed.
  Packed finishes are the hardest case.
- A number can be misread, most often with a digit missing. The app follows
  each bib across frames and takes the reading most frames agree on, which
  removes most of these, but not all.
- Any other number in view is a candidate: a year on a banner, a race clock, a
  car number plate. The scan zone, the digit and range settings and above all a
  start list deal with these.

Use the Mark button as a backup, review the photos afterwards, and for results
that matter run a second timing method alongside.

## The exported file

Times of day are in the iPad's time zone. Rows are in finishing order.

**Bib and time**

```
bib,time_of_day,elapsed
7,09:53:52.500,0:23:52.500
12,09:55:00.250,0:25:00.250
```

`elapsed` is empty if the race has no start time.

**All details** adds these columns:

| Column | Meaning |
| --- | --- |
| `position` | Finishing position at this station. |
| `name` | From the start list. |
| `utc` | The time as a UTC timestamp, e.g. `2026-11-25T14:53:52.500Z`. |
| `timing` | `line` (crossed the finish line), `estimated`, `firstSeen`, `lastSeen` or `manual`. |
| `source` | `camera` or `manual`. |
| `confidence` | The text recognizer's confidence, 0–1. |
| `sightings` | Number of frames in which the bib was read. |
| `clock` | `ntp` or `device` (the iPad's own clock). |
| `clock_error_ms` | Worst-case clock error when the time was taken. |
| `detected_bib` | What the camera read, if you corrected the number. |
| `station` | This iPad's station name. |
| `note` | Your note. |

## Settings

| Setting | What it does |
| --- | --- |
| Station name | Identifies this iPad in exports. |
| Time is taken | At the finish line (default), when first read, or when last read. |
| Record a bib more than once | For laps. With a minimum time between crossings of the same bib. |
| Digits, lowest and highest number | What counts as a bib number. Match these to your race. |
| Never record | Numbers to ignore, e.g. the year printed on every bib. |
| Read in N frames before it counts | Higher is stricter: fewer false readings, more missed bibs. |
| Certainty required | How sure the recognizer must be. |
| Smallest text | Smaller reaches further away but slows scanning. |
| Accept a look-alike letter | Reads `1O4` as `104`. |
| Keep a photo of each result | For checking afterwards. |
| Outline rejected text | Shows text that was read but did not count as a bib. Useful when setting up. |
| 4K video | Records more detail. Lower *Smallest text* as well to read bibs further away; scans get slower. |
| Longest exposure | A short exposure keeps moving bibs sharp. Use a longer one or Automatic in poor light. |
| Scans per second | Fewer keeps the iPad cooler over a long day. |
| NTP time servers | Default: `time.apple.com`, `time.cloudflare.com`, `pool.ntp.org`. A server on your own network can be used too. |
| Live results | Address and access key of your results hub, if you run one. See [Live results](#live-results-on-your-scoring-computer). |

## If something is not working

- **No outlines on bibs.** Move closer or zoom in; check the bib is inside the
  scan zone; switch on *Outline rejected text* to see what is being read. Try
  a lower *Smallest text*, with 4K video for bibs that are far away.
- **Bibs are outlined but nothing is recorded.** Press Record. If a start list
  is in use, the bib must be on it. Check the digit and number range settings.
- **Times are all marked estimated.** Bibs are not being read on both sides of
  the line. Move the line further up the picture, to where bibs are still
  comfortably readable.
- **Bibs blur as runners pass.** Choose a shorter *Longest exposure*.
- **The clock will not sync.** NTP uses UDP port 123, which some guest and
  corporate Wi-Fi networks block. Try a phone hotspot.
- **The iPad gets hot and slow.** Lower *Scans per second*, keep it out of
  direct sun, and take it out of its case.
- **The badge says "Not sent yet".** The iPad cannot reach the results hub at
  the moment. Results are safe on the iPad and are sent when the connection
  returns. If it never clears, use *Check the connection* in Settings: it says
  whether the address or the key is the problem. When the hub turns an upload
  down (a changed key, for example), the iPad tries again only every few
  minutes, to save data; a successful *Check the connection* makes it try at
  once.
- **A new hub address or key is not being used.** It only comes into use when
  **Connect** in Settings has succeeded. The message under the button says what
  went wrong.
- **The connector says "Waiting for RunScore to listen".** Nothing accepts a
  connection on that port. Check that RunScore's TCP input is started and that
  the port in the line is the one set in RunScore. Results recorded meanwhile
  are passed on as soon as it connects.
- **Results reach the connector's window but not RunScore.** RunScore accepted
  the connection but did not take the lines. Compare a line in the window with
  what RunScore expects: the marker (`-Prefix`), the line ending
  (`-LineEnding`), time of day or elapsed (`-Time`) and the timing-point name
  (`-Location`).
- **The hub page shows two events for one race.** The iPads are using different
  event codes. Make them the same in Race setup; the iPad then sends its
  results under the new code. Clear away the stray one, and anything left from
  a practice run, with **Remove event** on the hub page.

## For developers

```
BibTimer.swiftpm/        the app (a Swift Playgrounds app project)
  Core/                  platform-independent logic: NTP packets and clock
                         maths, bib rules, tracking, results, CSV export,
                         and what is sent to the hub
  Time/                  NTP client (Network.framework) and sync service
  Recognition/           Vision text recognition
  Capture/               camera and the frame-analysis pipeline
  Storage/               races on disk
  Sync/                  uploading results to the hub
  UI/                    SwiftUI screens
Package.swift            test/CI manifest: the same sources as a library
Tests/                   unit tests for the app
hub/                     the results hub (Node, no dependencies) and its tests
  public/runscore.ps1    the connector that passes results on to RunScore
Dockerfile               builds the hub, for Railway or any container host
```

The root `Package.swift` compiles everything in `BibTimer.swiftpm` except the
app entry point as a library, so the tests run with `swift test`. On Linux that
covers the core logic, checks the NTP packet code against public time servers,
and drives the app's upload client against a running hub. On macOS it also runs
the real Vision recognizer against generated pictures and the real UDP client
against a local time server. The hub has its own tests: `cd hub && node --test`.
They include the RunScore connector, run by whichever PowerShell is installed
against a real hub and a TCP server that stands in for RunScore (skipped where
there is no PowerShell). CI (`.github/workflows/ci.yml`) runs all of these,
runs the connector on Windows with both Windows PowerShell and PowerShell 7,
builds the hub's Docker image, compiles all app sources for iOS and builds the
app project.

How a time is produced:

1. `NTPClient` exchanges a few packets with each server. `NTPSelection` picks
   the offset most servers agree on. The result is a `ClockFix`: the difference
   between the device's raw monotonic clock and UTC.
2. `CameraController` delivers upright frames. `CapturePipeline` reads each
   frame's capture timestamp, converts it to the monotonic clock, and runs
   `TextRecognizer`.
3. `BibFilter` keeps the text that looks like a bib number. `BibTracker` groups
   readings into tracks, votes on the number, and interpolates the time at
   which the track crosses the finish line.
4. `RaceClock` converts that monotonic time to time of day with the current
   fix. `CrossingLedger` applies the once-per-bib rule and `RaceStore` saves.
5. If a hub is set up, `HubSync` uploads what changed since the last upload the
   hub accepted (`HubPlanner` works that out) and sends everything again
   whenever the hub's answer shows it holds something else.
