# Retailer Suites — promo script

- **Composition:** `RetailerSuitesPromo` · 1920×1080 · 30 fps · 2150 frames (71.67s)
- **Voice-over:** one continuous Bangla take, **Ashwat — Calm, Pleasant Storyteller**
  (ElevenLabs v4), 71.55s, used at its recorded speed
- **Language:** Bangla source copy; English kept for product names, plan names, prices and the domain
- **Fonts:** Anek Bangla (display/headlines), Hind Siliguri (Bangla body), Inter (Latin)
- **Scene overlap:** 15-frame (0.5s) cross-fade between every scene

## The film is cut to the voice, not the other way round

`voiceover/take.srt` is the subtitle file that came back with the take. Its cues are machine chunks
that run across sentence boundaries ("…একটাই account। counter যা যা"), so they are not scene marks
as they stand; `src/timing.ts` locates the moment each *claim* is spoken inside its cue and turns
that into a frame. Every scene then reads its reveals from there.

That is why nothing on screen is early or late: a plan card arrives on its own name, a feature tile
lights while its line is being read and hands the light to the next one when the voice moves on.

Earlier cuts of this film fitted the take with `atempo` to hit a round 60s. This one does not — the
picture is as long as the read, plus a third of a second of air after the last word.

Every number below comes from the application, not from copywriting: plan names, prices, limits and
the trial length are read out of `server/src/seed/plans.seed.ts`,
`server/src/config/productLimits.ts` and `server/src/services/subscription/trialPolicy.ts`; the
feature-per-tier split comes from `docs/ENTITLEMENTS.md`; and the third line on every feature card is
the rule the server actually enforces, cited per card in `src/data.ts`.

---

## Scene 1 — Hook & brand · 0:00–6:36 (frames 0–198)

| Spoken at | On screen | Voice-over |
|---|---|---|
| 0:00.2 | **দোকানের হিসাব এখনো খাতা-কলমে?** | "দোকানের হিসাব এখনো খাতা কলমে?" |
| 0:02.9 | a pen line strikes the question through | — |
| 0:03.3 | RS logomark springs in | "Retailer Suites," |
| 0:03.9 | **Retailer Suites** | — |
| 0:04.5 | এক প্ল্যাটফর্মেই আপনার পুরো ব্যবসা | "এক platform আপনার পুরো ব্যবসা।" |

## Scene 2 — Four POS verticals · 6:36–13:04 (frames 198–391)

| Spoken at | On screen | Voice-over |
|---|---|---|
| 0:06.9 | FOUR POS, ONE ACCOUNT · **আপনার ব্যবসার ধরন অনুযায়ী POS** | "আপনার ব্যবসার ধরন অনুযায়ী POS," |
| 0:09.2 | 01 Clothing POS — সাইজ, রঙ ও ভ্যারিয়েন্ট | "fashion," |
| 0:09.9 | 02 Super Shop POS — VAT, মার্জিন ও ডেড স্টক | "super shop," |
| 0:10.7 | 03 Restaurant POS — টেবিল, অর্ডার ও কিচেন টিকেট | "restaurant" |
| 0:11.5 | 04 Pharmacy POS — ব্যাচ, এক্সপায়ারি ও প্রেসক্রিপশন | "আর pharmacy," |
| 0:12.3 | একটাই account — প্রতিটি ব্যবসার জন্য আলাদা workspace | "একটাই account।" |

## Scene 3 — At the counter · 13:04–30:52 (frames 391–916)

Eyebrow EVERY PLAN INCLUDES · **কাউন্টারে যা যা দরকার, সবই আছে**

| Spoken at | Card | Third line (the rule) |
|---|---|---|
| 0:15.0 | দ্রুত বিক্রি ও বারকোড স্ক্যান · Fast billing | EAN-13 ও CODE128 স্ক্যান |
| 0:17.0 | সরাসরি রিসিট প্রিন্ট · Direct thermal print | QZ Tray বা NanoPrint — প্রতি কম্পিউটারে |
| 0:19.7 | স্প্লিট ও কাস্টম পেমেন্ট · Split payment | ব্রাঞ্চের অনুমোদিত মেথড · চেঞ্জ শুধু ক্যাশে |
| 0:22.6 | ইনভেন্টরি লেজার ও স্টক · Inventory ledger | প্রতিটি মুভমেন্ট লেজারে, স্টক ফিল্ডে নয় |
| 0:25.1 | রিটার্ন, এক্সচেঞ্জ, রিফান্ড · Return & exchange | ডিসকাউন্টের অনুপাতে রিফান্ড |
| 0:27.7 | এক্সেল থেকে বাল্ক ইমপোর্ট · Bulk import | Excel ও CSV — সব প্ল্যানে |

## Scene 4 — Growing the business · 30:52–44:60 (frames 916–1338)

Eyebrow GROW WITH PROFESSIONAL · **ব্যবসা বড় করার টুলস**

| Spoken at | Card | Third line (the rule) |
|---|---|---|
| 0:31.6 | মাল্টি-ব্রাঞ্চ ম্যানেজমেন্ট · Multi-branch | সব ব্রাঞ্চ এক ড্যাশবোর্ডে, এক রেঞ্জে |
| 0:33.9 | স্টাফ রোল ও পারমিশন · Custom roles | প্রতি রিকোয়েস্টে সার্ভারেই যাচাই |
| 0:36.2 | লয়ালটি কার্ড প্রোগ্রাম · Loyalty program | স্ক্যান করা কার্ডেই পয়েন্ট, ফোনে নয় |
| 0:38.8 | SMS ও ইমেইল মার্কেটিং · Marketing | কাস্টমারকে ক্যাম্পেইনে ফিরিয়ে আনুন |
| 0:40.9 | অ্যাডভান্সড অ্যানালিটিক্স · Advanced analytics | নেট সেল, কস্ট, গ্রস প্রফিট ও মার্জিন |
| 0:42.3 | রিপোর্ট প্রিন্ট ও ডেটা এক্সপোর্ট · Export & print | PDF প্রিন্ট · CSV, Excel, JSON এক্সপোর্ট |

## Scene 5 — Pricing · 44:60–63:60 (frames 1338–1908)

Eyebrow MONTHLY · BDT · **স্পষ্ট প্রাইসিং, আপনার মাপে**

| Spoken at | Card |
|---|---|
| 0:46.3 | **Starter ৳990/মাস** · বার্ষিক ৳9,900 · ribbon "৭ দিন ফ্রি ট্রায়াল" · ১টি ব্রাঞ্চ, ২ জন স্টাফ · ৩,০০০ প্রোডাক্ট · ৫০০ কাস্টমার · মাসে ২,৫০০ সেল · সেলস রিপোর্ট ও ইনভেন্টরি লেজার |
| 0:50.3 | **Professional ৳1,990/মাস** · বার্ষিক ৳19,900 · ribbon "সবচেয়ে জনপ্রিয়" · ২টি ব্রাঞ্চ, ৬ জন স্টাফ · ৩০,০০০ প্রোডাক্ট · ১০,০০০ কাস্টমার · লয়ালটি + মার্কেটিং · অ্যাডভান্সড অ্যানালিটিক্স ও এক্সপোর্ট |
| 0:56.9 | **Enterprise ৳2,990/মাস** · বার্ষিক ৳29,900 · ribbon "আনলিমিটেড" · ১০টি ব্রাঞ্চ, আনলিমিটেড স্টাফ · আনলিমিটেড প্রোডাক্ট · আনলিমিটেড কাস্টমার ও সেল · সব ফিচার একসাথে · প্রায়োরিটি সাপোর্ট |
| 1:01.2 | ✦ **বার্ষিক প্ল্যান নিলে ২ মাস একদম ফ্রি** | 

## Scene 6 — Free trial & CTA · 63:60–71:67 (frames 1908–2150)

| Spoken at | On screen |
|---|---|
| 1:03.6 | **৭ দিনের ফ্রি ট্রায়াল** |
| 1:06.3 | Starter মাসিক প্ল্যানে — আগে ব্যবহার করুন, তারপর সিদ্ধান্ত নিন |
| 1:08.6 | Button: **আজই ফ্রি অ্যাকাউন্ট খুলুন** |
| 1:10.0 | **retailersuites.com** |
| 1:10.8 | RS · Retailer Suites |

---

## The rail

A corner lockup, the name of the section being read, the address and a progress line sit outside the
`TransitionSeries` in `src/ui/Rail.tsx`, so they never cross-fade: six scenes read as one broadcast
rather than six slides, and the viewer can always see where they are and how much is left. It fades
in after the opening logo has had the screen to itself and out before the closing lockup arrives.

Render without it for a clean cut:

```bash
npx remotion render RetailerSuitesPromo out/no-rail.mp4 --props='{"rail":false}'
```

## Accuracy notes

- The 7-day free trial is carried by the **Starter monthly** plan only — `trialDays` is 0 on
  Professional and Enterprise and on every annual variant, so the qualifier under the big "৭" in
  Scene 6 is not fine print, it is the rule the server enforces.
- Annual prices are exactly ten months of the monthly price, which is where "২ মাস ফ্রি" comes from.
- Enterprise is unlimited on staff, products, customers and monthly sales, but **10 branches**, not
  unlimited — Scene 5 says so rather than rounding it up.
- Bulk import is on **every** plan and data export is Professional and above; the two are separate
  flags (`docs/ENTITLEMENTS.md`), which is why "সব প্ল্যানে" sits on the import card and the export
  card sits in the growth scene.
- Loyalty points move on a **scanned card**, never on a phone number (`docs/LOYALTY_UNIVERSAL.md`).
- No claim about VAT, setup fees, refunds or hardware is made anywhere in the video, because the
  repository does not state one.

## Working on it

```bash
cd promo-video && npx remotion studio
```

Each scene is also registered on its own (Studio → *Scenes* folder) so it can be previewed in
isolation; its length there comes from the same `timing.ts` the film uses.

```bash
cd promo-video && npx remotion render RetailerSuitesPromo out/retailer-suites-promo.mp4
```

## Re-recording the voice-over

1. Drop the new take at `public/voiceover/promo-full.mp3` and its subtitle file at
   `voiceover/take.srt`.
2. Re-derive the seconds in `src/timing.ts` from the new .srt, and set `TOTAL` to the take's length
   in frames plus a little air.
3. Nothing else changes: scene lengths, cuts and every reveal are computed from those numbers.

The composition's `voiceover` prop defaults to `true`; pass `false` for a clean track:

```bash
npx remotion render RetailerSuitesPromo out/silent.mp4 --props='{"voiceover":false}'
```
