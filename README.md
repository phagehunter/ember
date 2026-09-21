# Ember

**Early pre-release (0.x).** Free spaced-repetition flashcards for Mac and Windows. Ember uses the same scheduling algorithm as Anki (FSRS-6) and keeps the parts that make it work: short learning steps, four grades, and a target of 90% recall at review time. It drops the parts that get in the way, so making cards takes a minute and reviewing feels calm.

No account, no subscription, no internet needed after install. Your cards live in one file on your computer.

## Download

Open the **Releases** page (right side of this repository) and pick the file for your computer:

| Computer | File to download |
|---|---|
| Mac with Apple Silicon (M1, M2, M3, M4) | `Ember_x.y.z_aarch64.dmg` |
| Mac with an Intel processor | `Ember_x.y.z_x64.dmg` |
| Windows 10 or 11 | `Ember_x.y.z_x64-setup.exe` |

Not sure which Mac you have? Click the Apple menu → About This Mac. "Chip: Apple M…" means Apple Silicon.

### First launch on a Mac

Ember is not signed with a paid Apple developer certificate, so macOS will warn that it can't verify the developer. This is normal for small open-source apps. To open it the first time:

1. Open the `.dmg` and drag **Ember** into **Applications**.
2. In Applications, **right-click** Ember and choose **Open**, then click **Open** again.
3. On macOS 15 or newer, if that doesn't work: open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to Ember.

You only do this once.

**If macOS says "Ember is damaged and can't be opened":** it isn't damaged. That wording is what Gatekeeper shows for unsigned downloads. With Ember already in Applications, open **Terminal** (Spotlight → type Terminal) and paste this line, then press Return:

```bash
xattr -cr /Applications/Ember.app
```

Then open Ember normally. This removes the "downloaded from the internet" flag from the app; it changes nothing else.

### First launch on Windows

If Windows SmartScreen appears, click **More info**, then **Run anyway**.

## Using Ember

**Today** shows how many cards are due. Click **Start reviewing**, read the question, think of the answer, then click **Show answer**. Grade yourself honestly:

| Button | Meaning | Key |
|---|---|---|
| Again | Forgot it | 1 |
| Hard | Got it, but it took real effort | 2 |
| Good | Got it | 3 |
| Easy | Instant, no effort | 4 |

Each button shows when the card will come back. Space flips the card, E edits it, U undoes the last grade.

**Add cards** has two routes:

**Add cards** is one box. Type or paste your cards and Ember shows you what it found before anything is saved. It reads:

- `question | answer`, one per line, with an optional third `|` part for a hint.
- `Q:` and `A:` on separate lines, or a question line followed by its answer line.
- Markdown tables, tab-separated columns, and `question :: answer`.
- `{{c1::hidden text}}` anywhere, which makes a fill-in-the-blank card.
- `Deck: Name` on its own line, sending the cards below it to that deck and creating it if needed.
- `#tag` at the end of a line.

To have an AI assistant write them for you, click **Copy prompt**, paste it into Claude, ChatGPT, Gemini or anything else along with your notes, and paste the reply back into the box. It answers in plain text, so no file and no paid account is needed.

**Browse** searches every card. Click one to edit, suspend, reset, or delete it. Tick several to move them to another deck, tag them, suspend them, reset their progress, or delete them together.

**Stats** shows your recall rate over the last 30 days, your streak, a review heatmap, and how many cards are due over the next month.

**Settings** tunes the scheduler and makes backups. **Save backup** writes everything to one file. **Restore backup** reads one back in and asks which deck the cards should join, without deleting anything.

## Where your cards are stored

One file, shown at the bottom of Settings:

- Mac: `~/Library/Application Support/com.curtishoffmann.ember/ember-data.json`
- Windows: `%APPDATA%\com.curtishoffmann.ember\ember-data.json`

Back it up from Settings now and then. To move to a new computer, install Ember there and restore the backup.

## How the scheduling works

Ember implements FSRS-6 (Free Spaced Repetition Scheduler) with its published default parameters, the same algorithm Anki has used since version 23.10. Every card carries two numbers: **stability**, the days until your chance of recall drops to 90%, and **difficulty**. Each grade updates them, and the next review is placed where your recall is predicted to reach the target you set in Settings.

Defaults match Anki: learning steps of 1 and 10 minutes, a 10 minute relearning step after a lapse, a 90% recall target, a small random spread so reviews don't clump, 20 new cards and 200 reviews per day, and a day that rolls over at 4 am so late-night sessions count as the same day.

## Building it yourself

Installers are built automatically by GitHub Actions when a version tag such as `v0.0.1` is pushed. Versions below 1.0 are early pre-releases: expect rough edges, and keep backups. To build on your own machine you need Node.js, Rust, and on a Mac the Xcode command line tools:

```bash
npm install
npm run icons
npm run build
```

The app is a single HTML page in `dist/` with no framework and no build step, wrapped in a native window by [Tauri](https://tauri.app). Cards are stored with Tauri's file-system plugin.

## Contributing and support

Found a bug or have an idea? Open an issue on this repository. Pull requests are welcome.

## License

MIT. The FSRS algorithm comes from the [open-spaced-repetition](https://github.com/open-spaced-repetition) project.
