# Bib Timer

Time a race with iPads and nothing but Safari. Open a web page on an iPad,
point the iPad at the finish line, and it reads the runners' bib numbers with
its camera, gives each one a time, and sends the list to a results page that
your scoring computer reads from, downloads as CSV, or feeds into RunScore.

- **Nothing to install on the iPads.** The camera is a page on your own
  website (`https://your-address/capture/`). The same website collects the
  results.
- **Bibs are read on the iPad itself**, from live video. No video or photo
  leaves the iPad; only numbers and times are sent.
- **A finish line drawn on the picture.** A bib's time is worked out for the
  moment it crosses that line, not for whenever it happened to be read.
- **One clock for every iPad.** Each iPad keeps its clock in step with the
  website's, which checks its own against time servers, and shows how exact
  that is.
- **A Mark button** takes a time by hand for any runner the camera cannot
  read; the number is typed in afterwards, with a photo of the moment to go by.
- **Every result can be checked and corrected**, on the iPad, with a small
  photo of the runner.
- **Results are kept on the iPad as well as sent**, so a lost connection, a
  flat battery or a page that Safari reloads does not lose a race.
- **Each iPad's results separately, or all together**, live on the results
  page, as CSV files, or passed straight into **RunScore** over TCP.

> **Try it with your own iPads well before race day.** The whole chain is
> exercised by automated tests in desktop browsers, with a stand-in for the
> camera (see [What has been tested](#what-has-been-tested)). It has **not been
> run on a real iPad**. How fast an iPad reads, and how many runners it
> catches, depends on the iPad, the light, the distance and the bibs, and only
> a dry run shows it. Keep a backup timing method for anything that matters.

If you *can* install an app on the iPads, there is one, and it is the better
camera: see [The iPad app](docs/ipad-app.md). It sends its results to the same
website, so app and page can be mixed.

## Contents

- [How it fits together](#how-it-fits-together)
- [What you need](#what-you-need)
- [1. Put the site on Railway](#1-put-the-site-on-railway)
- [2. On each iPad](#2-on-each-ipad)
- [3. On the scoring computer](#3-on-the-scoring-computer)
- [Sending results straight into RunScore](#sending-results-straight-into-runscore)
- [How many runners will it catch?](#how-many-runners-will-it-catch)
- [How accurate are the times?](#how-accurate-are-the-times)
- [How much mobile data it uses](#how-much-mobile-data-it-uses)
- [What is sent, and keeping it private](#what-is-sent-and-keeping-it-private)
- [The files](#the-files)
- [Settings on the camera page](#settings-on-the-camera-page)
- [If something is not working](#if-something-is-not-working)
- [What has been tested](#what-has-been-tested)
- [For developers](#for-developers)

## How it fits together

```
iPad (Finish A) ─┐                 ┌─▶ results page, live (any browser)
iPad (Finish B) ─┼─ results ─▶ site ┼─▶ CSV files, per iPad or combined
iPad (Start)    ─┘   (the site also ├─▶ RunScore, through a small program
   Safari, at        serves the     │   on the scoring computer
   /capture/         camera page)   └─▶ JSON, for anything else
```

One small website does everything: it serves the camera page to the iPads,
takes in their results, and gives them out again. It is the `hub` folder of
this repository, and it runs on any host that can run a Docker image. These
instructions use [Railway](https://railway.com).

**The race does not depend on the connection.** Each iPad keeps every result
itself and sends it afterwards. If the signal drops, the iPad carries on
reading, and sends what it has when the signal returns.

## What you need

- **iPads with iPadOS 16.5 or later; 17 or later is better.** Safari is the
  only thing used. Newer iPads read faster. An iPhone works too. The page
  takes a good deal of memory while it reads (600 to 700 MB in a desktop
  browser), which Safari may not grant on iPads from before about 2019: there
  it may reload the page from time to time.
- **The website**, set up once (next section).
- **A connection for the iPads**: Wi-Fi, a phone hotspot or cellular. It is
  needed when the page is first opened (which fetches about 15 MB, once: do
  that on Wi-Fi), to set the clock, and to send results. It may come and go
  during the race.
- **A tripod or clamp, and power.** The iPad has to stay still, and reading
  bibs is hard work for it.

## 1. Put the site on Railway

Railway's menus change from time to time, so a name may differ slightly from
what is written here.

1. In Railway, create a **New Project**, choose **Deploy from GitHub repo** and
   pick this repository. Railway builds the site from the `Dockerfile` in the
   repository; there is nothing to configure for the build. The build fetches
   the program that reads bib numbers, so it takes a couple of minutes.
2. Open the new service's **Variables** and add `HUB_KEY`. Make it a long
   phrase nobody would guess (at least 8 characters; 20 or more is better).
   This is the access key: anyone who has it can see and change the results.
   It is not something the site gives you; you choose it here, and type the
   same phrase wherever the site asks for the access key.
3. In the service's **Settings**, under networking, **generate a domain**. You
   get an address like `https://something.up.railway.app`. If Railway asks
   which port the app listens on, it is the number in the log line
   `[hub] listening on port …` (normally 8080).
4. Recommended: add a **Volume** to the service, mounted at `/data`. Results
   are then kept across restarts. Without one the site starts empty after every
   restart, and the iPads fill it again by themselves the next time their page
   is open and online.
5. Open the address in a browser and enter the key. The page says that no
   results have arrived yet, and shows the way to the camera page.

Optional variables:

| Variable | Effect |
| --- | --- |
| `HUB_VIEW_KEY` | A second key that can look at results but not change them, for an announcer or a results screen. It cannot be used on the iPads. |
| `HUB_TIME_SERVERS` | The time servers the site checks its own clock against, separated by commas. Default: `time.cloudflare.com,time.google.com,time.apple.com,pool.ntp.org`. `none` switches the check off. |

When this repository changes, Railway builds and starts the new version by
itself. An iPad picks up a new version of the camera page the next time the
page is loaded; one that is open during the change shows a message and carries
on with the version it has until you choose to load the new one.

## 2. On each iPad

### Open the camera page

In **Safari**, go to your address with `/capture/` at the end:

```
https://YOUR-ADDRESS/capture/
```

The first time, the page asks for the **access key** and keeps it on the iPad.
To save typing, press **Copy a link for the iPads** on the results page and
send that link to the iPads (AirDrop, or a message): opening it enters the key.
The link contains the key, so treat it like a password.

The first time, the page also fetches the program that reads numbers: about
15 MB. Do this on Wi-Fi, before race day. It is kept on the iPad, so it is not
fetched again, and the page then opens even without a connection.

### Set up the race

- **Race.** On the first iPad choose *A new race* and name it. On the others,
  either give the race the same name (iPads that name a race the same on the
  same day are put together), or pick it from the list, where it appears once
  the first iPad is set up.
- **Where this iPad stands.** Its own name for each iPad: *Finish A*,
  *Finish B*, *Start*. This is how their results are told apart later.

A race from an earlier day can be cleared off the iPad here: choose it and tap
**Remove this race from this iPad**. What the results site holds stays there.

Tap **Open the camera** and allow the camera when Safari asks. Safari asks
again every time the page is loaded unless you tell it not to: tap the icon at
the left of the address bar, **Website Settings**, and set **Camera** to
**Allow**. Do that; a page that Safari has to reload in the middle of a race
then gets its camera back without anyone tapping anything.

### Set up the iPad itself

- **Settings → Display & Brightness → Auto-Lock → Never.** The page keeps the
  screen awake by itself; this is the second line of defence.
- **Low Power Mode off** (Settings → Battery), and the iPad **on power**.
- **Keep the page in front.** Safari stops the camera of a page that is not on
  screen. *Guided Access* (Settings → Accessibility) locks the iPad to Safari
  so that a stray touch cannot leave it.
- **Only one tab** with the camera page. A second one says so and steps aside.
- If the iPad has little storage left, free some: the page keeps the reading
  program, your results and their photos on the iPad.

### Position the iPad

Bibs are on the front of the runners, so the camera has to face them.

- Put the iPad **just past the finish line, looking back at the runners coming
  toward it**, as square-on as you can.
- Mount it **above head height, tilted down**, if you can. From up there it
  sees over the front runners to the ones behind, and bibs move steadily down
  the picture as runners approach, which is what the finish line needs.
- Keep the sun behind the camera where possible. Bibs in deep shadow, or with
  the sun behind the runners, are hard to read.
- Landscape covers a wider course. Fix the iPad before you draw the line: the
  line is drawn on the picture, and turning the iPad turns the picture.
- **Fill the picture with the place where runners finish.** A number is read
  reliably once its digits are about a fortieth of the picture's height
  (2.5 %), and more easily when larger. Move closer, or zoom in (Settings →
  Zoom, where the iPad offers it).

### The finish line and the search area

The picture shows what the camera reads: every number it takes for a bib gets
a box. Have someone wearing a bib walk through the finish and watch the box:
**yellow** means read once, **orange** means it is being followed, **green**
means its time has been taken. This works before recording is started, so use
it to try things out.

Tap **Finish line**:

- Drag the **round ends** to lay the line where the bibs are in the picture at
  the moment runners cross your real finish line. The **arrow** shows the way
  runners go; **Turn the arrow round** if it points the wrong way.
- Drag the **square corners** to mark out the part of the picture where bibs
  can be. Leave out banners, clocks, parked cars and spectators. **This is the
  most useful thing you can do for speed:** the smaller the area, the more
  often the iPad can look at it.

Put the line a little above the bottom of the area, where bibs are still easy
to read: a bib has to be read on both sides of the line for its crossing to be
timed exactly.

### Check the clock

The badge at the top right shows the clock's state.

| Badge | Meaning |
| --- | --- |
| Green, `Clock ±25 ms` | The clock was set by the site and is within that much of the site's time. |
| Orange, `Clock ±400 ms` | Set over a slow connection, or long ago. Tap it to set it again. |
| Orange, `iPad's own clock` | The site could not be reached. Times come from the iPad's clock and are marked as such. |

Tap the badge to set the clock again and see the details. The page sets it by
itself when it opens, every five minutes, and whenever the iPad comes back
from sleep or the connection returns.

**Poor signal at the venue?** The clock only needs the connection now and
then: once set, it stays set while the page is open, and the badge allows
for it drifting by up to seven hundredths of a second an hour until it is set
again. If results do get timed by the iPad's own
clock (the page was loaded again, or the iPad slept, with no connection), the
page **fills in their exact times by itself** as soon as it has reached the
site again. It can do that as long as it has stayed open since: it knows the
moment of each result on its own even-running clock. Results it cannot put
right any more stay marked *iPad clock*, and the Race sheet says how many
there are.

### Record

Tap **Record** when the first runner is near. From now on every bib the camera
reads is added to the list with its time. Each bib is recorded once (for races
with laps, change that in Settings).

- **Mark** takes a time at this instant with no number, and keeps a photo of
  the picture as it was. Use it for any runner the camera is not going to read
  (bib covered, folded, missing) and fill in the number afterwards.
- **Add now**, next to the count, takes a time at this instant for a number
  you type.
- Tap **Stop** when the race is over.

The badge next to the clock shows what has reached the site: **Sent**,
**Sending 3**, or **No connection · 12 waiting**. Waiting results are kept on
the iPad and go by themselves when the connection is back.

### Check and correct

The list shows the newest result first. Tap one to see its photo, correct the
number or the time, add a note, or delete it. Things to look for:

- **`?`** : a mark that still needs its number.
- **by hand** : taken with Mark or Add now, not read by the camera.
- **estimated** : the bib was only read on one side of the line, so the
  nearest reading was used. Usually within a second.
- **more than once** : two results have the same number; one of them is a
  misread or a second pass.
- **read as 117** : the number was corrected by hand; this is what the camera
  read.
- **iPad clock** : timed without the site's clock.

Under **Race**:

- **Start time.** Tap **The race starts now** at the gun, or type the time of
  day. Results then show the time since the start as well. Without a start
  time, results carry the time of day, which is all a scoring program needs.
  With several iPads, set it on one: the site passes it to the results page.
- **Start list.** Paste one runner per line, bib number first
  (`101, Jane Doe`); copying two columns out of a spreadsheet works. Names then
  appear in the list, and with *Only record numbers that are on this list* the
  camera ignores every other number it sees. This is the single most effective
  way to keep stray numbers out.
- **Download CSV** gives this iPad's results as a file, straight from the
  iPad.

### If the page goes away

Safari sometimes reloads a page, most often after the iPad has been used for
something else. The page is built to come back as it was:

- The race, its results and the settings are kept on the iPad and are there
  again.
- If it was recording, **recording is switched on again**, and a message says
  from when to when nothing was read.
- It opens **without a connection** too, from the copy kept on the iPad.

Results are also on the site as soon as they are sent, and an iPad never
takes anything off the site that it has not itself deleted: not when its page
is loaded again, and not when a race is cleared off the iPad. After the race,
download the CSV files from the results page: Safari may clear what a site has
kept on an iPad if the site is not visited for some weeks.

## 3. On the scoring computer

Open your address (without `/capture/`) in any browser and enter the key.

The page lists the results of all iPads in order, updating every couple of
seconds. You can hide an iPad, show one row per bib (the earliest, useful with
two iPads on the same line), and download the CSV. Each iPad shows when it was
last heard from; an iPad checks in every 45 seconds even when nothing is
happening, so one that has been silent for a few minutes has lost its
connection or its page has been closed.

**Each iPad on its own.** Every iPad has a **CSV** button of its own on the
page, which downloads just that iPad's results, whatever else is ticked. The
file is named after the race and the iPad (`spring-run-20261128-finish-a.csv`).
The big **Download CSV** and **Copy CSV link** buttons cover the iPads that are
ticked, so unticking all but one gives that iPad's detailed file or link too.
All of this works while the race is still being recorded: a download is the
results as they stand at that moment. Give the iPads different names
(*Finish A*, *Finish B*); if two have the same name, the page calls the second
one *Finish (2)* so that they can still be told apart.

To fetch the results from scoring software or a script instead, use the direct
address (the page's **Copy CSV link** button builds it for you):

```
https://YOUR-ADDRESS/api/events/RACE-CODE/results.csv?key=YOUR-KEY
```

The race code is the race's name and date in lower case
(`spring-run-20261128`); the camera page shows it under **Race**.

| Add to the address | Effect |
| --- | --- |
| `&format=detailed` | All columns instead of bib, time of day, elapsed and station. |
| `&stations=Finish A` | Only this iPad, or several: `Finish A,Finish B`. |
| `&dedupe=first` | One row per bib: the earliest. |
| `&tz=America/New_York` | Times of day in this time zone (default: the iPads' own). |

The same address ending in `results.json` gives everything as JSON. The key can
also be sent as an `Authorization: Bearer YOUR-KEY` header, which keeps it out
of the address.

`elapsed` is measured from the start time set on an iPad. If more than one iPad
has a start time, the one set most recently is used, and the page shows which
iPad it came from.

To clear away a practice run, use **Remove event** on the results page. An
iPad that still has that race open sends it again, so delete the results on
the iPad too (**Race → Delete all results of this race**) or start a new race.

## Sending results straight into RunScore

[RunScore](https://runscore.com) can take results over a TCP connection, one
line of text per result, in its open format:

```
RSBI,214,10:23:45.67,Finish A
```

That is the marker for a bib number, the bib, the time of day and the name of
the timing point. RunScore listens for that connection on the scoring computer
itself, and a website cannot reach into your computer. So the last step is
done by a small program that runs on the scoring computer: it fetches each new
result from the site and hands it to RunScore.

```
iPads ── upload ─▶ site ◀─ fetches ── connector ── TCP ─▶ RunScore
                 (Railway)           └──── on the scoring computer ────┘
```

The connector runs in Windows PowerShell, which every Windows computer has.
There is nothing to install.

1. **In RunScore**, set up the timer input for its open format over TCP, give
   it a port (3988 is a common choice) and start it. In the versions of
   RunScore described online this is under *Tools → Initialize → External
   Timer*, which has a TCP box and a port; that has not been checked against
   RunScore itself. What matters is that RunScore listens on a TCP port for
   lines that begin with `RSBI`.
2. **On the results page**, open **Send results to RunScore**, enter the port,
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
  on the page and make a line for each port. Run one connector per port, not
  two into the same one.
- **An iPad whose clock is not set.** Its results are passed on all the same,
  and the window warns, once, that its times come from the iPad's own clock.
- **A click in the window.** In the classic Windows console a click selects
  text, and Windows then holds the program up until Enter is pressed. The
  connector switches that off for its window. Should the window ever seem
  stuck all the same, click in it and press Enter; nothing is lost meanwhile.
- **Data.** The connector asks the site to hold each request until there is a
  result, so it uses little: about 0.14 MB an hour when nothing is happening
  and under 1 KB per result, which comes to about 0.3 MB for a two-hour race
  with 150 results and 0.8 MB with 1,000 (measured by counting every byte on
  an encrypted connection, as for the iPads below).

Things that can be added to the end of the line:

| Addition | Effect |
| --- | --- |
| `-RunScorePort 3988` | The port RunScore listens on. |
| `-RunScoreHost 192.168.1.20` | RunScore on another computer on the same network (default: this one). |
| `-Location FINISH` | The same timing-point name on every line. |
| `-Decimals 3` | Thousandths of a second; 0 to 3 digits (default 2). |
| `-Time elapsed` | Time since the start set on an iPad instead of time of day. |
| `-Prefix RSBCI` | Another marker at the start of each line. The default, `RSBI`, says the number is a bib number. RunScore's format also has `RSCI` (a chip code) and `RSBCI`, which at least one other timing system sends to RunScore; try that one if `RSBI` lines are not taken. |
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

## How many runners will it catch?

Nobody can say before you have tried it on your iPads, and this page has not
been run on a real one. What can be said:

**It reads less often than the app does.** The camera page looks at the
picture a few times a second; the number is shown at the top of the picture
(*Reading · 2.4 looks a second*). The nearest thing to an iPad it has been
timed on is Safari's engine on an Apple-silicon Mac in a test centre: there a
look at a whole picture with one bib in it took about 0.43 seconds on one
processor core and 0.25 seconds on two, and a little longer with every
further bib in view. An iPad with an M-series chip should be close to that;
older iPads will be slower, by how much is not known.

**What a bib needs** in order to be recorded: to be readable in two looks (so
that one stray reading is not believed), and for an exact time, in one look
before the line and one after. At three looks a second, that is a bib that
stays readable, facing the camera, for about a second around the line. A
runner alone gets that. In a tight bunch, the ones hidden behind others do
not.

**In the tests**, with drawn runners moving steadily down a drawn picture and
never hiding one another, every bib was recorded and none wrongly. That shows
that the chain works, not what a real finish gives.

**Where it gives out** was tried the same way, with drawn runners coming
thicker and faster, on the computer the page was developed on (where a look
with one core takes about as long as it did in Safari's engine on the
Apple-silicon Mac). Each line is thirty runners:

| Runners arriving | Each bib readable for | Recorded, one core | Recorded, two cores |
| --- | --- | --- | --- |
| 1.7 a second | 3 s | 30 of 30 | |
| 3.3 a second | 1.8 s | 29 of 30 | |
| 3.3 a second | 1.2 s | 26 of 30 | 30 of 30 |
| 3.3 a second | 0.8 s | 18 of 30 | 24 of 30 |
| 6.7 a second | 1.8 s | 15 of 30 | 30 of 30 |
| 6.7 a second | 1.2 s | 8 of 30 | 23 of 30 |

No number was recorded wrongly in any of these. The pattern is the useful
part: the page copes with a steady stream, and starts to lose runners when
many are in the picture at once and each is readable for little more than a
second. Every bib in view makes each look take longer, so a crowd slows it
down just when it is needed most. Real runners also hide one another, which
drawn ones did not, so expect a real finish to be below these figures, and a
packed one well below. As a planning figure, assume the page misses more than
the app would, and that someone has to catch the misses with **Mark**.

**What raises it**, most effective first:

1. **Make the search area small** and the bibs large in it. Both make every
   look quicker and surer.
2. **Mount the iPad high**, looking down the line of runners, so that they
   hide one another less.
3. **Two iPads on the same line**, from different sides. Each catches bibs the
   other misses, and the results page shows one row per bib if asked.
4. **A start list**, with *Only record numbers that are on this list*. It does
   not find more bibs, but it turns misreads into nothing instead of into
   wrong results.
5. **Settings → How closely each picture is searched.** Left on *Automatic*
   the page searches quickly when it reads with one core, which looks more
   often and needs bibs to be a fortieth of the picture's height. *Standard*
   and *Thorough* find smaller bibs and look less often: use them only where
   runners are few and far from the camera.
6. **Settings → For fine-tuning → Processor cores**: try 2 (or 4 on an iPad
   with an M-series chip) and keep it if the looks a second go up. Left to
   itself the page uses one core on an iPad, because reading with several
   needs something that Safari has been reported to refuse on some versions of
   iPadOS. If it does not work, the page goes back to one core by itself.
7. **Settings → Readings before a number is believed → 1** catches runners
   that are only readable for an instant, at the price of more misreads. Use it
   only together with a start list.

What stays hard whatever is set: a bib covered by an arm, folded, pinned at
the side, in deep shadow, or hidden behind another runner. Any other number in
view is a candidate too (a year on a banner, a race clock, a number plate);
the search area, the digit and range settings and a start list deal with those.

## How accurate are the times?

**The clock.** A page in a browser cannot ask a time server itself, so each
iPad asks the site, in the way a time server is asked: several times over, and
it keeps the answer that spent the least time on the way. Half of that time is
how far off the result can be, and that is the figure on the badge: typically
10 to 50 ms on a good connection, more on a poor one. The site in turn checks
its own clock against four time servers and takes the answer most agree on.
If the hosting service does not let it ask them, the page says so when you tap
the badge; a hosting service's clock is normally right to a few thousandths of
a second anyway. All iPads take their time from the same site, so they agree
with one another to within their badges.

**The moment.** Each picture is stamped with the moment it was taken, not the
moment the reading finished, so slow reading does not delay a time. With the
finish line, the time is worked out between the readings on either side of the
crossing, assuming the runner moved steadily between them. In the tests, where
runners do move steadily, that came out within a hundredth of a second. Real
runners at a few looks a second: expect one or two tenths. Results marked
*estimated* can be off by a second or so.

**The camera's delay.** A picture takes a moment to get from the lens to the
screen, and no browser says exactly how long. The page takes off 60 ms, a
typical figure; the true one for your iPad may differ by a few hundredths of
a second, the same for every runner. It can be changed under Settings → For
fine-tuning.

## How much mobile data it uses

Very little once the page is loaded. Only numbers and times are sent, never
video or photos. These figures were measured with the real page in a desktop
browser, over an encrypted connection of the kind a hosting service provides,
counting every byte in both directions:

| What | Data |
| --- | --- |
| Opening the page for the first time on an iPad | about 15 MB, once. Do it on Wi-Fi. |
| Opening it again later | about 15 KB, plus what follows |
| One result | about 0.6 KB |
| Saying "still here" every 45 seconds | about 0.5 KB each: 42 KB an hour |
| Setting the clock every five minutes | about 1.4 KB each: 17 KB an hour |
| Sending a race again after the page was reloaded | about 0.2 KB per result |

For **one iPad with the page open for two hours** that comes to:

| Results recorded on that iPad | Data used by that iPad |
| --- | --- |
| 150 | about 0.2 MB |
| 300 | about 0.3 MB |
| 600 | about 0.5 MB |
| 1,000 | about 0.7 MB |
| 2,000 | about 1.3 MB |

- These are the figures when the connection to the site stays open between
  uploads, which checking in every 45 seconds is there to achieve. On a poor
  signal the iPad has to connect afresh, which costs a few KB each time.
- Tap the **Sent** badge to see roughly how much the page has sent since it
  was opened.
- A new version of the camera page is a few hundred KB. The 15 MB reading
  program is only fetched again if it changes itself, which is rare.

On the **scoring computer**, opening the results page with 400 results already
in takes about 27 KB. After that the page only fetches what is new: at most
about 1 MB an hour while it stays open, and well under 1 KB per result.
Downloading the CSV file of 460 results takes 4 KB.

iPadOS itself can use far more data than all of this, for example by syncing
photos or downloading updates. To stop that on race day, switch on **Low Data
Mode** for the connection the iPads use (*Settings → Cellular → Cellular Data
Options*, or for a hotspot *Settings → Wi-Fi →* ⓘ next to its name).

## What is sent, and keeping it private

Sent to the site: bib numbers, times, how each time was taken, the name of the
iPad's place, the race name and your notes. Not sent: video, photos, and the
names on the start list. Those never leave the iPad.

Everything travels over HTTPS, and nothing can be read or written without the
key. Treat the key, and any link that contains it, like a password. To change
it, change `HUB_KEY` on Railway; each iPad then asks for the new one.

The camera page loads nothing from anywhere but your own site.

## The files

Times of day are in the iPads' time zone. Rows are in finishing order.

**The plain file** (`Download CSV`):

```
bib,time_of_day,elapsed,station
7,09:53:52.500,0:23:52.500,Finish A
12,09:55:00.250,0:25:00.250,Finish A
```

`elapsed` is empty if the race has no start time.

**With all details** the columns are:

| Column | Meaning |
| --- | --- |
| `position` | Finishing position among the rows in the file. |
| `bib`, `time_of_day`, `elapsed` | As above. |
| `utc` | The time as a UTC timestamp, e.g. `2026-11-25T14:53:52.500Z`. |
| `timing` | `line` (crossed the finish line), `estimated`, `firstSeen`, `lastSeen` or `manual`. |
| `source` | `camera` or `manual`. |
| `confidence` | How sure the reader was when the result was recorded, 0–1. |
| `clock` | `ntp` (the site's clock, or a time server in the app) or `device` (the iPad's own clock). |
| `clock_error_ms` | How far off the clock could have been when the time was taken. |
| `station` | The name of the iPad's place. |
| `note` | Your note. |

For RunScore there is also a text file of `RSBI` lines (**Download as a
RunScore file** on the results page).

## Settings on the camera page

| Setting | What it does |
| --- | --- |
| Moment | A time is taken when the bib crosses the line (default), when it is first read, or when it is last read. |
| Readings before a number is believed | Higher is stricter: fewer misreads, more missed bibs. Default 2. |
| Record a bib each time it comes past | For laps, with a shortest time between two passes of the same bib. |
| Fewest and most digits, lowest and highest number | What counts as a bib number. Match these to your race. |
| Numbers that are never bibs here | Numbers to ignore, e.g. the year printed on every bib. |
| Smallest numbers to read | Larger skips distant runners and small print, and is a little quicker. |
| Read a look-alike letter as its digit | Reads `1O4` as `104`. |
| Lens, Zoom | Which of the iPad's cameras, and how far it is zoomed in, where Safari offers the choice. |
| How closely each picture is searched | *Quick*, *Standard* or *Thorough*: more looks a second, or smaller bibs found. *Automatic* (the default) is Quick when reading with one core and Standard with several. |
| Keep a small photo with each result | For checking afterwards. Photos stay on the iPad. |
| Processor cores used for reading | See [How many runners will it catch?](#how-many-runners-will-it-catch) |
| Camera delay | See [How accurate are the times?](#how-accurate-are-the-times) |

## If something is not working

**On an iPad**

- **"This browser is too old to read bibs."** The page needs iPadOS 16.5 or
  later. Update the iPad (Settings → General → Software Update).
- **"The results site is missing its bib reader."** The site was built without
  the reading program. Deploy it again from this repository with the
  `Dockerfile` it comes with.
- **The camera does not start.** Safari was not allowed to use it: tap the
  icon at the left of the address bar, **Website Settings**, **Camera →
  Allow**, then **Start the camera**. If another app is using the camera,
  close it.
- **"Fetching the bib reader" stays at one figure.** The connection is slow or
  gone; about 15 MB has to arrive the first time. It carries on where it can.
- **"Bib reader not working" or "Bib reader off".** The reading program did
  not start on this iPad. Tap the button on the message to try again. Times
  can be taken with **Mark** meanwhile. If it never starts, the iPad may be too old or too
  short of memory: close other apps and tabs, restart Safari, and set *How
  closely each picture is searched* to *Quick*.
- **No boxes on bibs.** Move closer or zoom in; check that the bib is inside
  the search area and that *Fewest and most digits* fit your numbers. Try
  *Thorough*.
- **Boxes on bibs, but nothing is recorded.** Tap Record. If *Only record
  numbers that are on this list* is on, the bib must be on the list.
- **Times are all marked estimated.** Bibs are not being read on both sides of
  the line. Move the line further up the picture, to where bibs are still
  comfortably readable, and make sure the arrow points the way runners go.
- **Few looks a second.** Make the search area smaller, keep the iPad cool
  and on power, switch Low Power Mode off, and try 2 cores.
- **The page says it was not in front, or was loaded again.** Something else
  was on screen, or Safari reloaded the page. Nothing was read in the time
  shown; take those runners from your backup. Guided Access keeps the page in
  front.
- **The badge says "iPad's own clock".** The site cannot be reached. Results
  are timed by the iPad and marked; when the connection is back the page
  fills in their exact times, provided it has stayed open meanwhile.
- **"No picture from the camera."** The camera says it is on and sends
  nothing: Safari has paused it, or another app has taken it. The page starts
  the camera afresh by itself; if that does not help it says so, and a tap on
  **Start the camera** tries again. Take times with **Mark** meanwhile.
- **The badge says "No connection".** Results are safe on the iPad and are
  sent when the connection returns.
- **The badge says "Not accepted".** The site refused the upload, most likely
  because the key was changed. Settings → **Forget the access key**, then
  enter the new one. Results stay on the iPad meanwhile.
- **"This page is already open."** It is open in another tab on this iPad.
  Close one of them.
- **The iPad gets hot and slow.** Keep it out of direct sun and out of its
  case; make the search area smaller.

**On the scoring computer**

- **The page shows two races for one race.** The iPads were given different
  race names, or set up on different days. On the iPad that is wrong, tap
  **Race → Another race…** and pick the right one from the list.
- **An iPad is listed twice.** It was given a new name during the race, or its
  Safari data was cleared, which makes it a new iPad to the site. Tick both.
- **The connector says "Waiting for RunScore to listen".** Nothing accepts a
  connection on that port. Check that RunScore's TCP input is started and that
  the port in the line is the one set in RunScore. Results recorded meanwhile
  are passed on as soon as it connects.
- **Results reach the connector's window but not RunScore.** RunScore accepted
  the connection but did not take the lines. Compare a line in the window with
  what RunScore expects: the marker (`-Prefix`), the line ending
  (`-LineEnding`), time of day or elapsed (`-Time`) and the timing-point name
  (`-Location`).

## What has been tested

So that you know what you are relying on:

- **Tested automatically, on every change:** the timing logic (which numbers
  are bibs, following them, the moment of crossing, once per bib); the clock
  arithmetic; what is sent to the site and when; the site itself; the RunScore
  connector on Windows, against a stand-in for RunScore.
- **Tested automatically in real browsers** (Chromium, and WebKit, the engine
  of Safari, on a Mac, also made up to look like an iPad): the camera page
  from signing in to results on the site, with drawn runners in place of a
  camera; correcting results; the settings; dragging the finish line;
  reloading while recording; working, and being loaded again, with the site
  gone; two iPads at one race; falling back when the quicker reading program
  is refused. In these tests every drawn bib was recorded, with times within
  0.06 seconds of where the drawing put them.
- **Not tested:** anything on a real iPad. In particular how fast and how well
  it reads real bibs, how Safari on an iPad treats the camera and a page that
  is open for hours, and how warm the iPad gets. And nothing has been tried
  against RunScore itself.

## For developers

```
hub/                     the site (Node)
  server.js, lib/        the server: results store, RunScore feed, clock check
  public/                the results page and the RunScore connector
  public/capture/        the camera page
    lib/                 timing logic shared with the tests: bib rules,
                         tracking, results, clock arithmetic, upload planning
    engine.js            finds and reads text with the two models
    ocr-worker.js        runs the engine away from the page
    capture.js ...       camera, overlay, storage, uploads, the page itself
    sw.js                keeps a copy of the page on the iPad
  scripts/vendor.mjs     copies the reading program out of npm packages
  test/                  tests run by "node --test"
  e2e/                   the camera page driven in a browser
BibTimer.swiftpm/        the iPad app (a Swift Playgrounds app project)
Package.swift, Tests/    the app's sources as a library, and its tests
Dockerfile               builds the site, for Railway or any container host
docs/ipad-app.md         the app's own instructions
```

Running the site yourself:

```
cd hub
npm ci                    # fetches the reading program into public/vendor
HUB_KEY=your-long-key node server.js
```

It needs Node 20 or later, listens on `PORT` (8080 unless set), and keeps its
copy of the results in `DATA_DIR` (`hub/data` unless set). The server itself
uses no packages; `npm ci` only fetches what the camera page reads numbers
with. Without it the site still collects and shows results, and its camera
page says that the reader is missing. Browsers only give a page the camera
over HTTPS (or on `localhost`), so put the site behind something that provides
that.

How a time is produced on the camera page:

1. `hub.js` asks the site for the time (`/api/time`) a few times and
   `lib/timesync.js` keeps the answer that spent least time on the way: the
   difference between the page's even-running clock and the site's. The site
   checks its own clock by NTP (`lib/ntp.js` on the server).
2. `camera.js` hands over each new picture with the moment it was taken.
   `capture.js` cuts out the search area and sends it to `ocr-worker.js`, where
   `engine.js` finds text (PP-OCR detection model) and reads it (recognition
   model) with ONNX Runtime Web.
3. `lib/bibfilter.js` keeps the text that looks like a bib number.
   `lib/tracker.js` groups readings into tracks, votes on the number, and works
   out when each track crosses the finish line. `session.js` turns that into
   time of day; `lib/ledger.js` applies the once-per-bib rule.
4. `storage.js` keeps races on the iPad. `hub.js` sends what has changed since
   the last upload the site accepted (`lib/planner.js` works that out), and
   everything again whenever the site's answer shows it holds something else.

The reading program comes in two forms (`reader.js`). The quick one is ONNX
Runtime Web 1.31 with several threads, which needs shared memory; its request
for memory is lowered from 4 GB to 1 GB at install time, and its helper
threads are started from a copy the page holds, because a browser fetches a
worker's program past the service worker. The plain one is ONNX Runtime Web
1.18, the last version built without shared memory, on one thread. iPads get
the plain one unless told otherwise, and any browser falls back to it if the
quick one fails to start.

Tests:

```
cd hub
npm ci
node --test                          # the site, the logic, the connector (where PowerShell is installed)
node e2e/capture.e2e.mjs             # the camera page in Chromium; needs Playwright
node e2e/capture.e2e.mjs --browser=webkit --device=ipad
swift test                           # the app's logic, from the repository root
```

CI (`.github/workflows/ci.yml`) runs all of these, the browser tests in
Chromium and in WebKit on macOS, the connector on Windows with both Windows
PowerShell and PowerShell 7, builds the Docker image and checks that it
contains the reading program, compiles the app for iOS and builds the app
project.

### Other people's work

The camera page reads numbers with [ONNX Runtime Web](https://github.com/microsoft/onnxruntime)
(Microsoft, MIT License) and the PP-OCR text detection and recognition models
from [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) (PaddlePaddle
Authors, Apache License 2.0), taken as packaged for browsers in
[paddleocr-browser](https://github.com/xulihang/paddleocr-browser) (xulihang,
MIT License). None of it is in this repository: `npm ci` fetches it, and the
site serves it together with a notice of these terms (`/vendor/NOTICE.txt`).
