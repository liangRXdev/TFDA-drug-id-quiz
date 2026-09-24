# Drug ID Quiz (藥品辨識王)

**English** | [繁體中文](README.zh-TW.md)

[![Live Demo](https://img.shields.io/badge/Live%20Demo-Click%20Here-blue?style=for-the-badge)](https://liangrxdev.github.io/TFDA-drug-id-quiz/)

A self-test for pharmacists on identifying drugs by appearance. Questions are drawn from the Taiwan Food and Drug Administration (TFDA) "Drug Appearance Dataset": identify the English brand name from the real photo and appearance features. The interface is in Traditional Chinese.

- Three difficulty levels; each round has **10 or 20 random questions** (your choice) with no repeated answer keys
- **Flashcard mode**: unscored, just look at the image and flip to see the name — for getting familiar before a quiz
- **Retry mistakes**: after a round, re-ask the questions you missed (same drug name, a different real photo, new distractors)
- Shows your current streak while answering and awards a title at the end; best score and longest streak for each level are stored **locally in the browser**
- **Hospital formulary customization**: a teaching pharmacist pastes the hospital's license numbers → generates a link → trainees who open it are only quizzed on the hospital's drugs
- At the end you get a total score and per-question review; the score card can be downloaded as PNG
- Pure static, zero build, no backend, no accounts; **installable as a PWA** (requires a connection)

## Difficulty

| Level | Question type | Hint | Chance baseline |
|---|---|---|---|
| **Easy** | Image → pick one of four drug names (with Chinese name) | — | 25 |
| **Medium** | Drug name → pick one of four images | Eliminate one wrong option (max 0.5 points) | 25 |
| **Hard** | Image → type the English brand name | First letter + length (max 0.5 points) | 0 |

**Scores across levels are not comparable**, and the score card says so. On Easy, getting a quarter right is just the expected value of guessing;
using Hard's pass mark would label "almost entirely guessing" as acceptable — so each level has its own thresholds, and the chance baseline is always shown.

Each question's three distractors are guaranteed to be **distinguishable** from the answer: on Easy, distractor appearance (shape, color) never overlaps the answer;
on Medium the distractors deliberately share shape and color and differ only in imprint, because that level tests imprint recognition.
Both levels exclude distractors with names that are too close (edit distance ≤1 or prefix containment), so "spells alike" is never mistaken for "recognizes".

### The Chinese name on Easy is a known trade-off

Options on Easy show both the English name and the **full official Chinese name**. Chinese names almost always contain a dosage-form word,
and Easy's distractors are deliberately chosen with non-overlapping appearance while the on-screen "shape" feature already says capsule or tablet —
put together, **in an 800-question simulation, 22.4% of questions could be answered from "capsule / tablet" alone**, without actually recognizing the drug.

> This 22.4% was measured on the 3,913-record pool version and **has not been rerun on the 3,924-record version** — the simulation was never committed as a script.
> The direction of the trade-off doesn't change with small shifts in this number, but before quoting an exact value the simulation should be written as a rerunnable script under `tools/`.

It is still done this way because the alternative is worse: stripping the dosage-form word from the displayed Chinese would no longer show the full official name,
and a truncated Chinese drug name becomes a source of confusion in clinical settings. So it is handled by **labelling** instead —
the difficulty card states "the Chinese name can reveal the dosage form", so the score isn't misread as appearance-recognition ability.

If you really want to practice appearance recognition, use Medium or Hard.

## Flashcards (unscored)

A deck of 20 cards, image only; flip to reveal the name. No answering, no scoring, no difficulty to choose. Good for getting familiar before a quiz.

After flipping, if the photo's appearance **matches more than one drug**, the back lists all other names sharing that appearance.
The pool has 124 appearance keys mapping to multiple drug names (covering 311 questions, 7.9%, up to 9 distinct names in one group) —
listing too few would teach a false one-to-one "this appearance = this drug", which is the main failure mode of this mode.

Score lines and size are deliberately ignored when deciding whether an appearance is unique: both are weak signals in a photo
(score lines are shallow, size needs a ruler for comparison). Flashcards show photos, and claiming uniqueness based on features a photo can't show does not hold.

## Question Count (10 / 20)

After choosing a difficulty you can pick 10 or 20 questions for the round; default is 20.

**Best records for the two lengths are stored separately.** 9/10 is 90 points and 18/20 is also 90 points,
but they are not equally hard — put in the same slot, the short quiz becomes a shortcut to high scores. It is the same reason
the three levels keep separate records. The start page's record summary therefore always states the length (`Easy 10 Q 90.0 / 20 Q 85.0`).

In hospital-formulary mode, if a level doesn't have enough eligible drug names, that length is **marked unavailable with the reason**;
it never silently switches to a shorter quiz. With 10–19 eligible items you can still take the longest quiz that level supports
(e.g. 19 questions) — that existing short-quiz behavior was kept when the option was added.

Flashcard count and retry-mistakes count are **not affected by the length choice**: the former is an unscored browsing mode,
and the latter's count is simply how many you got wrong.

## Retry Mistakes

After a round, the results page shows "Retry mistakes (N)", where N is the number you got wrong in that round.
It builds an N-question review quiz from the **same answer keys**: the drug names stay the same, but **the photo is redrawn from that drug name's
records**, distractors are redrawn and the answer position is reshuffled. Only moving the answer around would train position memory, not appearance.

**Review quizzes are not recorded, earn no title and produce no score card**; the results page only shows "M of N correct this time" and the per-question review.
The reason is the same as "scores across levels are not comparable": the denominator isn't 20 and the questions aren't a random sample
but a deliberately selected subset of hard ones — scores, chance baselines and streaks computed on it aren't comparable across rounds.
Both the question page and the results page show "not counted toward records", so it's always clear you're reviewing.

**Abandoning midway terminates the whole review and returns to the original results**; gaps are never filled with other drugs from the pool.
In a normal round an image that fails to load is automatically replaced with another question, but that replacement draws "any unused drug" —
used in a review quiz it would inevitably mix in drugs you didn't get wrong, invisibly,
and you'd believe you had reviewed all your mistakes. That is this feature's main failure mode.
Medium (four images) therefore **loads all the quiz images before starting the review**; if they can't all load, it doesn't start.

## Best Records

Each of the three levels **separately** records its best score and longest streak in the browser's `localStorage`.
Expand "My best records" on the start page to view and clear them (collapsed, it shows each level's best score).
Nothing is uploaded or synced; switching devices or clearing browser data loses them — the tool has no backend and no accounts.

Score and streak are **judged separately**: a higher score with a shorter streak only updates the score and doesn't wipe the previous longest streak.
If storage is unavailable (private mode, blocked), the feature silently degrades without affecting quizzes or results.

## Question Pool

Data version 2026-08-03 (the data-generation date of the source ZIP, shown in the footer). The table below is the filtering result for that version;
the `update-pool` workflow recomputes it after each monthly scheduled update — **the numbers change, the criteria don't**.

| Filter stage | Remaining |
|---|---|
| Source (opendata 42) | 6,269 |
| Q1 solid oral dosage forms | 5,698 |
| Q2 has image | 5,697 |
| Q3 answer key length ≥3 | 5,689 |
| Q4 has imprint | 4,094 |
| **Q5 appearance distinguishable from other products** | **3,924** |

The 3,924 questions map to **3,135 distinct English brand names** (one name can have multiple photo records, so there are more questions than names).
Each round (10 or 20 questions) samples names, not records, without repetition. Easy and Hard can draw from all 3,135;
Medium needs three distractors with the same shape and color but a different imprint, leaving **3,067** usable names (97.8%).

Q4 and Q5 are deliberate: "round / white / no score line" alone can't uniquely identify a drug,
and groups with identical appearance but different names (83 groups measured) would mark a pharmacist wrong for an answer that is "correct for a different pill" —
reinforcing a false memory. **Better 170 fewer questions than a wrong verdict.**

## Hospital Formulary Customization

Trainees need to recognize **the few hundred drugs on their own hospital's shelves**, not all 3,941 in Taiwan.
A teaching pharmacist expands "Teaching pharmacist tools" on the start page → clicks "Generate hospital list link" and pastes the hospital's license numbers (one per line;
for multi-column Excel data, specify the delimiter and column yourself). The system produces a URL; trainees who open it get **questions and distractors drawn only from hospital items**.

**Zero backend — the list is fully encoded in the URL.** No data is uploaded; there are no accounts or server-side state.

### Unmatched items fall into three categories, with numbers

Not every pasted license number can become a question. The tool explains each category rather than just saying "N failed":

| Category | Meaning | Count in full dataset |
|---|---|---|
| Oral but not solid | Liquids / powders for syrup / granules, etc. | 572 |
| Insufficient question quality | No imprint (1,603) / appearance not distinguishable (170) / name too short (8) / no appearance image (1) | 1,782 |
| **Not in the appearance dataset** | Mostly injections, topicals, eye drops and other non-oral forms; may also be delisted or mistyped | — |

The wording of the third category is deliberate. The source is an **oral** drug appearance dataset — its shape field only has round / capsule / oval… /
liquid / granule, **no injections, no topicals, no eye drops**. Hospital lists use injections every day;
flagging them as "license not found, please check" would make teaching pharmacists distrust the whole tool.
And the tool **cannot distinguish** "valid but not oral" from "genuinely mistyped" — it doesn't pretend to make a distinction it can't make.

### N and K are two different numbers

- **N** = number of matched items (how many pasted license numbers are in the dataset)
- **K** = number of answer keys usable **at that level**

K is smaller than N and **differs by level**: Medium needs distractors with the same shape and color but different imprints;
a measured 300-item list had N=300 but K for L2 was only 248. The two numbers are shown separately and never stand in for each other.

Whether a level is available **isn't decided by whether K is large enough** but by **actually building a quiz** —
per-key eligibility ignores the whole-quiz context, while each question's distractors can't be another question's answer in the same quiz,
and neither implies the other. Levels that can't be supported are greyed out **with the reason written out** (how many names are missing, the minimum needed),
rather than hidden so it looks like the tool is broken.

### Other behavior

- **Hospital mode doesn't write best records**, only showing the current round's score. Different hospitals' lists would share one record and the baseline changes when switching lists,
  so that number has no comparable meaning
- **Items disappearing after a monthly update degrade rather than block**: the list is re-matched against the current pool and the reduced numbers shown,
  but **the original list is never overwritten** — items that come back later are restored automatically.
  The "no longer in the latest data" warning **appears only when an item is missing from both datasets**;
  items "in the dataset but unsuitable for questions" get a grey explanatory note, not a warning color
- Expand "Question pool and data source" on the start page to **switch back to the full pool** (this removes the list from this browser; reopen the link to use it again).
  It is deliberately tucked away rather than in the main line of sight: it is destructive, and being easy to press is not a virtue
- The full URL is capped at 1,800 characters; beyond that, link generation is explicitly refused rather than producing a link some platforms would truncate

## Development

Requires Node ≥22 (`node --test` glob expansion arrived in Node 21) **and uv** —
one `npm test` acceptance group must really decode corrupted WebP with Pillow, which only the Python side can do
(see `tests/fetch_images_probe.py`). Without uv that group **fails rather than skips**.

```bash
npm test                 # engine, difficulty levels, flashcards, UI wiring, engagement, retry mistakes, hospital list, start-page IA, data pipeline and SW boundary (630 tests)
npm run build:pool       # fetch source → data/pool.json
npm run fetch:images     # mirror images → data/img/*.webp (needs uv)
npm run verify           # data integrity checks
npm run icons            # redraw PWA icons from icon.svg geometry (needs uv)
```

Local preview must go through HTTP (ES modules and fetch don't work over `file://`):

```bash
python -m http.server 8000
```

## Architecture

```
engine.js                     Pure functions: normalization, judging, sampling, option generation, scoring, state machine, flashcards (tested)
formulary.js                  Pure functions: license-number normalization, link encoding (wire format v1), four-way classification, level availability
app.js                        DOM and events, resource-failure handling, score-card drawing, hospital-list loading and link generation
index.html                    Single file with inline styles
sw.js                         Service worker: caches the app shell only (see below)
data/pool.json                Surviving items (the question pool)
data/excluded.json            Excluded items and the stage that excluded them, for unmatched-item classification
tools/build-pool.mjs          Data pipeline (Node; imports engine.js to share normalization)
tools/fetch-images.py         Image mirroring and conversion (uv + Pillow)
tools/make-icons.py           Redraws PWA icons from icon.svg geometry (uv + Pillow)
tools/verify-data.mjs         Data integrity checks
tests/gold-set.json           47 manually confirmed name → answer-key mappings
tests/_ui-harness.mjs         Minimal DOM stub (jsdom deliberately not used)
tests/fetch_images_probe.py   Behavior probe for fetch-images.py (real Pillow; driven by fetch-images.test.mjs)
.ai-review/plan.md            Spec v3 (data pipeline and L3)
.ai-review/plan-v3-levels.md  Spec v3.6 (difficulty levels), with acceptance criteria and reasons for each revision
.ai-review/plan-v4-engagement.md  Spec v4.7 (streaks / titles / best records / animation / retry mistakes, with acceptance criteria and revision reasons)
.ai-review/plan-v5-formulary.md   Spec v5.11 (hospital formulary customization), with wire-format contract and acceptance criteria
.ai-review/golden-vectors-v1.md   Golden vectors for link encoding (derived by hand **before** the codec was implemented)
.ai-review/C51-manual.md          Matrix and results of the 375px manual record
.ai-review/v51-start-ia.md        Trade-offs of the start-page IA reordering, manual record and one outstanding existing defect
.ai-review/verdict-*.md       Item-by-item verdicts of each independent review
```

All judging, sampling and scoring live in `engine.js`; `app.js` only handles "how to draw" and "how to collect answers".
The data pipeline deliberately uses Node rather than Python so it shares the same `normalize()` with the frontend —
two implementations will inevitably drift, and drift means inconsistent answer judging.

Images are mirrored into the repo rather than hot-linked for three independent reasons: originals are 140 KB–6 MB,
the image host has no CORS (cross-origin images taint the canvas and score-card capture fails),
and it avoids every user hitting the TFDA server. Converting to WebP gives roughly 27× compression.

## PWA: installable, but not claimed to work offline

You can "Add to Home Screen" and use it as an app, but **the question pool and drug images are never cached**; offline it opens but can't load questions
and shows "cannot connect to load the question pool". This is a deliberate degradation, not a bug; the manifest description also says "requires a connection".

Two reasons, either sufficient to rule out offline:

1. Offline answering would require preloading all images (~50 MB), directly conflicting with "first screen < 3 MB"
2. Caching images creates "new pool with old images" version mismatches — a photo of drug A labelled with drug B's name.
   That is exactly the failure mode this tool fears most

So `sw.js` **doesn't even call `respondWith`** for requests under `data/`, behaving exactly as if there were no service worker;
the rest of the app shell is network-first, with the cache only as an offline fallback. This boundary is guarded by `tests/sw.test.mjs` —
the test actually loads `sw.js` into a controlled fake SW environment and drives its fetch handler, rather than matching source strings.

## License

**Code is under [MIT](LICENSE). The question pool and images under `data/` are not covered by that license.**

Those files are derived from the TFDA "Drug Appearance Dataset"; this project only mirrors and re-encodes them and
**claims no rights to them** — stamping MIT on the whole repo would claim the right to license
someone else's drug photos and dataset, which is not true. To reuse the contents of `data/`,
confirm the licensing terms with the data provider yourself (see the second paragraph of LICENSE).

## Data Source and Disclaimer

Question source: Taiwan Ministry of Health and Welfare, Food and Drug Administration, "Drug Appearance Dataset" (opendata 42).

This tool is for pharmacy education and self-practice, **not a basis for identifying drugs in clinical dispensing or administration**.
In practice, identify drugs by the original packaging, labels and your hospital's formulary data.
The question pool is a snapshot at a point in time and does not reflect current drug supply or license status.
