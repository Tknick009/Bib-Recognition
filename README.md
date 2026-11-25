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

> **Try it before race day.** The timing logic is covered by automated tests and
> the whole app is compiled in CI, but camera reading depends on your set-up:
> the light, the distance, the bibs. Do a dry run with a few people walking and
> running past, and keep a backup timing method for anything that matters.

## Contents

- [What you need](#what-you-need)
- [Putting the app on an iPad](#putting-the-app-on-an-ipad)
- [At the race](#at-the-race)
- [Several iPads](#several-ipads)
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

Keep the app on screen while recording. The iPad is kept awake.

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
  spreadsheet, keeping the earlier time for each bib.

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

## For developers

```
BibTimer.swiftpm/        the app (a Swift Playgrounds app project)
  Core/                  platform-independent logic: NTP packets and clock
                         maths, bib rules, tracking, results, CSV export
  Time/                  NTP client (Network.framework) and sync service
  Recognition/           Vision text recognition
  Capture/               camera and the frame-analysis pipeline
  Storage/               races on disk
  UI/                    SwiftUI screens
Package.swift            test/CI manifest: the same sources as a library
Tests/                   unit tests
```

The root `Package.swift` compiles everything in `BibTimer.swiftpm` except the
app entry point as a library, so the tests run with `swift test`. On Linux that
covers the core logic; on macOS it also runs the real Vision recognizer against
generated pictures and the real UDP client against a local time server. CI
(`.github/workflows/ci.yml`) runs both and compiles all sources for iOS.

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
