# Apple Bake

A small website that runs the Burton Conner Apple Bake (or any bake-off with a special ingredient):

- **Judge signup** (`/signup`): name, kerberos, phone, floor, dietary restrictions, and the categories they'd like.
- **Judge assignment**: at least 2 judges per category, co-judges from different floors, only diet-safe categories, and a cap on categories per judge. You can edit any assignment by hand afterwards.
- **Check-in** (`/checkin`, on the entry-table laptop, protected by a 6-digit PIN): baker name(s), one kerberos for the prize, floor, and each dish's name and category. The site hands out the dish numbers, or you can type the number written on the plate.
- **Judging by link**: you press "Start judging" and every judge gets a text with a personal link. They tap their favorite dish number in each category. Nobody has to reply by text.
  - If a dish is checked in after the texts go out, the judges of that category get a text asking them to taste it and confirm or change their pick.
  - Ties go to a third judge, who gets their own link. You can switch this to "ask the judges again" in Settings.
- **Special awards** (`/vote`): People's, Kids', and Alumni's Choice are voted on by phone. GRA's and Dog's Choice are typed in on the admin page.
- **Results** (`/results`): category winners, floor standings (the top 3 floors win), and a list of the winners' kerberos to copy into an email.
- **Every year is kept.** Each bake is an "event". Start a new one from last year's categories, change the ingredient (carrot, potato, ...), and old results stay viewable.

The site runs on Cloudflare's free tier, a Worker with a D1 database. Texts go out through Twilio, which is the only part that costs money.

## Set it up (about 30 minutes, plus waiting on Twilio)

### 1. Cloudflare account and database

1. Make a free account at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up).
2. Go to **Storage & databases > D1 SQL database > Create**. Name it `apple-bake` and create it.
3. Copy the **Database ID** it shows. Paste it into `wrangler.jsonc` in place of `REPLACE-WITH-YOUR-D1-DATABASE-ID`, and commit that change. The database ID is not a secret. It only works with your Cloudflare login.

You don't need to create any tables. The site sets up its own on the first visit.

### 2. Deploy

**Option A, from GitHub (no terminal needed).** Go to **Workers & Pages > Create > Import a repository** and pick this repo. Leave the build command empty. The deploy command is `npx wrangler deploy`. From then on, every push to `main` redeploys the site.

**Option B, from your computer.**

```sh
npm install
npx wrangler login
npx wrangler deploy
```

Either way, the site ends up at `https://apple-bake.<your-subdomain>.workers.dev`. You can attach your own domain later under the Worker's **Settings > Domains & Routes**.

### 3. Secrets (never put these in git)

In the Cloudflare dashboard, open the `apple-bake` Worker and go to **Settings > Variables and Secrets > Add**. Choose type **Secret** for each:

| Name | What it is |
| --- | --- |
| `ADMIN_PASSWORD` | The password for `/admin`. Pick a long one. |
| `TWILIO_ACCOUNT_SID` | From the Twilio console home page (starts with `AC`). |
| `TWILIO_AUTH_TOKEN` | From the same page. |

The terminal works too: `npx wrangler secret put ADMIN_PASSWORD`.

The site runs without the Twilio secrets. It just stays in test mode, where texts are logged on the admin page's **Texts** tab instead of sent.

### 4. Twilio (start this early)

1. Make an account at [twilio.com](https://www.twilio.com/try-twilio) and add a payment method.
2. Buy a phone number. A **toll-free** number is the simplest choice for one-off event texts.
3. Submit **toll-free verification** in the Twilio console (Messaging > Regulatory compliance). US carriers block unverified numbers, and verification can take a few days to a few weeks, so do it well before the bake. A local number needs A2P 10DLC registration instead, which has fees and also takes time.
4. On the site, go to **Admin > Settings** and enter the number as **Twilio phone number**, like `+18885551234`.
5. On **Admin > Overview**, use **Send yourself a real test text** in the Texting box. When it says "Delivered", turn off **Test mode**.

**Rough cost:** the number is about $1 to $2 a month, and each text is about a cent once carrier fees are included. For 30 judges and a few follow-ups, expect a few dollars per bake. Check [Twilio's pricing page](https://www.twilio.com/en-us/sms/pricing/us) for current numbers. You can release the number after the bake and buy a new one next year, but then you'd need to verify again.

## Running the bake

1. **Weeks before:** In **Admin**, click **+ New event**, start from last year, and set the ingredient. Check the **Categories** tab: `{ingredient}` in a name becomes the ingredient ("Craziest {ingredient}"). "OK for" says which dietary restrictions a category is safe for.
2. **Judge signup:** Share the `/signup` link. If you collected judges with a Google Form instead, paste the CSV export under **Judges > Import CSV**.
3. **Assign judges** on the Overview tab. Every category gets 2 judges from different floors. Judges left without a category are **backups**. Fix anything by hand on the Judges tab, and tick **Lock** on a judge to keep your changes if you assign again.
4. **Day of, entry table:** Open `/checkin` on the laptop and enter the PIN shown on the Overview tab. Every dish gets a number to write on its plate. You can fix any dish later on the **Dishes** tab, including its category.
5. **Judges check in** when they arrive by looking up their name at `/here` (on their phone or the check-in laptop). You can also tick **Here** on the Judges tab, or use **Check in everyone**. Only checked-in judges get texts.
6. **Start judging** on the Overview tab. You first see who will be texted and why, then confirm.
   - Only checked-in judges are texted. A category with fewer than 2 checked-in judges gets a checked-in backup. Other checked-in backups join a category they asked for, or a random one.
   - A category with only one judge is still judged; that judge decides alone.
   - A category needs at least 2 dishes to be judged. With 1 dish it wins automatically.
   - Afterwards, a judge who checks in gets their text right away, and late dishes are added and their judges get a text.
7. **Watch the "Still waiting" list.** Use **Re-send** on the Judges tab if someone lost their text.
8. **Voting:** Turn on **Voting is open** and print the QR code from the Overview tab for the tables. Type the GRA's and Dog's Choice winners and any paper tallies on the **Votes** tab.
9. **Results:** Check the **Results** tab. Type a dish number in **Override #** to change any winner. Then turn on **Results are public** and share `/results`. Copy the winners' kerberos from the box at the bottom.

## If texts don't arrive

- The **Texting** box on the Overview tab shows what's missing: the Twilio secrets, the Twilio phone number (Settings tab), or test mode still being on.
- **Send yourself a real test text** from that box. The result shows right below the button. The site then asks Twilio whether the text reached the phone and explains common problems in plain English, such as an unverified toll-free number, a trial account, or a wrong auth token.
- The **Texts** tab lists every text with its status. Click **Check delivery** to ask Twilio for the latest.
- Every send is also logged in Cloudflare: open the `apple-bake` Worker, then **Observability** (or **Logs**). Each text shows up as a line like `{"sms":{"to":"...1234","ok":false,"status":"not sent: ..."}}`, and each Start judging press as `{"startJudging":{...}}`.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # sets a local admin password; .dev.vars is gitignored
npm run dev                      # http://127.0.0.1:8787, with a local database
npm test                         # unit tests for the assignment, tiebreak and tally logic
npm run test:e2e                 # full run against the dev server, with made-up judges and dishes
```

`test/ui-smoke.cjs` clicks through every page in a real browser with Playwright and saves screenshots.

## Keeping secrets and personal data out of git

- Passwords and Twilio keys live only in Cloudflare's **Variables and Secrets** (or in `.dev.vars` on your own computer, which is gitignored).
- Judge names, phone numbers, and kerberos live only in the D1 database, never in the repo. The tests use made-up people.
- To back up a year, use the CSV downloads on the admin page and keep them somewhere private.
