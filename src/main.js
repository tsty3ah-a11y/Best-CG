import { Actor } from 'apify';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Add stealth plugin
chromium.use(StealthPlugin());

// ============================================
// FILTER AUTOMATION HELPERS
// ============================================

async function applyFilters(page, filters, searchRadius) {
    console.log('🎯 Applying UI filters...');

    // Each step returns true/false — if any fails, stop immediately and return false
    if (!await setSearchRadius(page, searchRadius)) return false;
    if (!await applyBodyTypeFilter(page, filters.bodyTypes)) return false;
    if (filters.makes && filters.makes.length > 0) {
        if (!await applyMakeFilter(page, filters.makes)) return false;
    }
    if (!await applyPriceFilter(page)) return false;
    if (!await applyDealRatingFilter(page, filters.dealRatings)) return false;

    console.log('✅ All filters applied successfully!');
    return true;
}

// ============================================
// CHURN-PROOF INTERACTION HELPERS
// CarGurus' filter panel re-renders continuously as its live listing counts
// update, so Playwright clicks (which wait for the node to be attached AND
// stable) time out against a remounting element. These act on the node
// synchronously inside the page — the click lands before the next re-render —
// then verify via detach-proof reads, polling through transient nulls so we
// never click twice and toggle a control back off.
// ============================================

// Short default on purpose: the filter accordions are lazy React components
// that sometimes never render on a bad page load. Failing in ~20s lets the
// outer 3-attempt loop restart with a fresh browser instead of hanging 90s.
async function waitForSelectorAttached(page, selector, timeout = 20000) {
    await page.locator(selector).first().waitFor({ state: 'attached', timeout });
}

// True if the selector currently matches an element in the live DOM.
async function isPresent(page, selector) {
    return page.evaluate((sel) => !!document.querySelector(sel), selector);
}

async function clickInPage(page, selector) {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.click();
        return true;
    }, selector);
}

async function readAttr(page, selector, attr) {
    return page.evaluate(({ sel, a }) => {
        const el = document.querySelector(sel);
        return el ? el.getAttribute(a) : null;
    }, { sel: selector, a: attr });
}

// Click `clickSelector` in-page and poll `checkFn` until it resolves truthy,
// tolerating transient nulls from re-renders. Returns true on success.
async function clickUntilState(page, clickSelector, checkFn, opts = {}) {
    const { clickAttempts = 6, pollCount = 12, pollGap = 250 } = opts;
    if (await checkFn()) return true;
    for (let a = 1; a <= clickAttempts; a++) {
        await clickInPage(page, clickSelector);
        for (let i = 0; i < pollCount; i++) {
            await page.waitForTimeout(pollGap);
            if (await checkFn()) return true;
        }
    }
    return false;
}

async function ensureAccordionOpen(page, triggerSelector, contentSelector, name) {
    const openNow = async () =>
        (await readAttr(page, triggerSelector, 'aria-expanded')) === 'true' ||
        (await readAttr(page, contentSelector, 'data-state')) === 'open';

    await waitForSelectorAttached(page, triggerSelector);

    if (await openNow()) {
        console.log(`  ✅ ${name} accordion is open`);
        return true;
    }

    if (await clickUntilState(page, triggerSelector, openNow)) {
        console.log(`  ✅ Opened ${name} accordion`);
        return true;
    }

    throw new Error(`${name} accordion did not open`);
}

async function findDistanceDropdown(page) {
    const selectors = [
        'select[data-testid="select-filter-distance"]',
        'select[aria-label="Distance from me"]',
        'select',
    ];

    for (const selector of selectors) {
        const matches = page.locator(selector);
        const count = await matches.count();

        for (let i = 0; i < count; i++) {
            const locator = matches.nth(i);

            try {
                await locator.waitFor({ state: 'visible', timeout: 3000 });

                const optionInfo = await locator.evaluate((select) =>
                    Array.from(select.options).map((option) => ({
                        value: option.value,
                        label: option.getAttribute('label'),
                        ariaLabel: option.getAttribute('aria-label'),
                        text: option.textContent.trim(),
                    }))
                );

                const hasExpectedOption = optionInfo.some((option) =>
                    option.value === '50000' ||
                    option.label?.toLowerCase() === 'nationwide' ||
                    option.ariaLabel?.toLowerCase() === 'nationwide' ||
                    option.text?.toLowerCase() === 'nationwide'
                );

                if (!hasExpectedOption) continue;

                console.log(`  ✅ Found distance dropdown using selector: ${selector}`);
                console.log(`  🔎 Distance options: ${JSON.stringify(optionInfo)}`);
                return locator;
            } catch (_) {
                // Try next visible match
            }
        }
    }

    return null;
}

async function setSearchRadius(page, searchRadius) {
    try {
        console.log(`🌍 Setting search radius to: ${searchRadius === 50000 ? 'Nationwide' : searchRadius + ' km'}`);

        const dropdown = await findDistanceDropdown(page);

        if (!dropdown) {
            throw new Error('Could not find distance dropdown using any known selector');
        }

        const options = await dropdown.evaluate((select) =>
            Array.from(select.options).map((option) => ({
                value: option.value,
                label: option.getAttribute('label'),
                ariaLabel: option.getAttribute('aria-label'),
                text: option.textContent.trim(),
            }))
        );

        let optionValue = searchRadius.toString();

        if (searchRadius === 50000) {
            const nationwideOption = options.find((option) =>
                option.value === '50000' ||
                option.label?.toLowerCase() === 'nationwide' ||
                option.ariaLabel?.toLowerCase() === 'nationwide' ||
                option.text?.toLowerCase() === 'nationwide'
            );

            if (!nationwideOption) {
                throw new Error(`Nationwide option not found. Available options: ${JSON.stringify(options)}`);
            }

            optionValue = nationwideOption.value;
            console.log(`  🌍 Nationwide option resolved to value: ${optionValue}`);
        }

        await dropdown.selectOption(optionValue, { timeout: 90000 });

        // Changing the radius makes CarGurus recompute every listing count in the
        // filter panel, which remounts the <select>. Verify with fresh re-queries
        // (never a held locator) so a mid-render detach doesn't hang inputValue().
        let selectedValue = null;
        for (let attempt = 0; attempt < 15; attempt++) {
            await page.waitForTimeout(1000);
            selectedValue = await page.evaluate(() => {
                const select = document.querySelector(
                    'select[data-testid="select-filter-distance"], select[aria-label="Distance from me"]'
                );
                return select ? select.value : null;
            });
            if (selectedValue === optionValue) break;
        }

        // A concrete wrong value is a real failure; null just means the <select>
        // was mid-remount for the whole verify window — selectOption() already
        // succeeded (it throws on failure), so trust it instead of aborting.
        if (selectedValue !== null && selectedValue !== optionValue) {
            throw new Error(`Distance dropdown value mismatch. Expected ${optionValue}, got ${selectedValue}`);
        }

        console.log(`  ✅ Search radius set successfully: ${selectedValue ?? optionValue}`);
        return true;

    } catch (error) {
        console.log(`  ❌ Search radius failed: ${error.message}`);

        try {
            await Actor.setValue(
                `debug-distance-dropdown-${Date.now()}.png`,
                await page.screenshot({ fullPage: true }),
                { contentType: 'image/png' }
            );
        } catch (_) {}

        return false;
    }
}

async function applyBodyTypeFilter(page, bodyTypes) {
    try {
        console.log(`🚗 Setting body types: ${bodyTypes.join(', ')}`);

        const trigger = '#BodyStyle-accordion-trigger';
        const content = '#BodyStyle-accordion-content';

        // Gate: confirm the Body Style panel actually rendered on this load.
        // If it never attaches, this page/variant is bad — fail fast so the
        // outer loop restarts with a fresh browser instead of hanging.
        try {
            await waitForSelectorAttached(page, trigger, 20000);
        } catch (_) {
            throw new Error('Body Style panel did not render (bad page load)');
        }

        const wanted = [];
        for (const bodyType of bodyTypes) {
            if (bodyType.includes('SUV')) wanted.push('SUV / Crossover');
            if (bodyType.includes('Pickup')) wanted.push('Pickup Truck');
        }

        // CarGurus' live listing counts re-render the whole panel, which can
        // re-COLLAPSE the accordion and unmount its checkboxes. So for each
        // body type we retry a full round: (re)open the accordion, wait for the
        // checkbox to exist, click it in-page, then verify — up to N rounds.
        for (const labelText of wanted) {
            const selector = `button[role="checkbox"][aria-label^="${labelText}"]`;
            const isChecked = async () => (await readAttr(page, selector, 'aria-checked')) === 'true';

            if (await isChecked()) {
                console.log(`  ✅ Body type: ${labelText} already selected`);
                continue;
            }

            let done = false;
            for (let round = 1; round <= 10 && !done; round++) {
                try {
                    await ensureAccordionOpen(page, trigger, content, 'Body Style');
                } catch (_) {
                    await page.waitForTimeout(1000);
                    continue;
                }

                if (await isChecked()) { done = true; break; }

                // Checkbox not in the DOM yet (accordion just opened / mid-render)?
                if (!(await isPresent(page, selector))) {
                    await page.waitForTimeout(1000);
                    continue;
                }

                await clickInPage(page, selector);
                for (let i = 0; i < 8; i++) {
                    await page.waitForTimeout(250);
                    if (await isChecked()) { done = true; break; }
                }
            }

            if (!done) throw new Error(`could not select ${labelText} after retries`);
            console.log(`  ✅ Body type: Added ${labelText}`);
        }

        await page.waitForTimeout(2000);
        return true;
    } catch (error) {
        console.log(`  ❌ Body type filter failed: ${error.message}`);
        return false;
    }
}

function normalizeMakeName(make) {
    const map = {
        ram: 'RAM',
        gmc: 'GMC',
        bmw: 'BMW',
        fiat: 'FIAT',
        mini: 'MINI',
        infiniti: 'INFINITI',
        'alfa romeo': 'Alfa_Romeo',
        'land rover': 'Land_Rover',
        'mercedes benz': 'Mercedes-Benz',
        'mercedes-benz': 'Mercedes-Benz',
    };

    const key = make.trim().toLowerCase();
    return map[key] || make.trim().replace(/\s+/g, '_');
}

async function clickMakeCheckbox(page, make) {
    const normalizedMake = normalizeMakeName(make);

    // querySelector-compatible click candidates (dropped the Playwright-only
    // `label:has-text()` fallbacks — the id/data-testid/aria-label paths cover
    // every make). Verify against the canonical checkbox id.
    const verifySelector = `button[role="checkbox"][id="FILTER.MAKE_MODEL.${normalizedMake}"]`;
    const clickSelectors = [
        `button[data-testid="checkbox-FILTER.MAKE_MODEL.${normalizedMake}"]`,
        `button[data-cg-ft="checkbox-FILTER.MAKE_MODEL.${normalizedMake}"]`,
        `button[id="FILTER.MAKE_MODEL.${normalizedMake}"]`,
        `button[role="checkbox"][aria-label="${make}"]`,
        `button[role="checkbox"][aria-label="${normalizedMake}"]`,
    ];

    const isChecked = async () => (await readAttr(page, verifySelector, 'aria-checked')) === 'true';

    try {
        await waitForSelectorAttached(page, verifySelector, 15000);
    } catch (_) {
        // Some makes render only under an aria-label match — keep going.
    }

    if (await isChecked()) {
        console.log(`  ✅ ${make} already selected`);
        return true;
    }

    for (let attempt = 1; attempt <= 6; attempt++) {
        let clicked = false;
        for (const sel of clickSelectors) {
            if (await clickInPage(page, sel)) { clicked = true; break; }
        }

        if (!clicked) {
            await page.waitForTimeout(400);
            continue;
        }

        for (let i = 0; i < 12; i++) {
            await page.waitForTimeout(250);
            if (await isChecked()) {
                console.log(`  ✅ Added ${make}`);
                return true;
            }
        }
    }

    return false;
}

async function applyMakeFilter(page, makes) {
    try {
        console.log(`🏭 Setting makes: ${makes.join(', ')}`);

        await ensureAccordionOpen(page, '#MakeAndModel-accordion-trigger', '#MakeAndModel-accordion-content', 'Make & Model');

        const showAllMakesButton = page.locator('button:has-text("Show all makes")').first();
        if (await showAllMakesButton.isVisible().catch(() => false)) {
            await showAllMakesButton.click({ timeout: 5000 });
            await page.waitForTimeout(1000);
            console.log('  ✅ Expanded make list');
        }

        await page.locator('#FILTER\\.MAKE_MODEL, ul[id="FILTER.MAKE_MODEL"]').first()
            .waitFor({ state: 'visible', timeout: 90000 });

        for (const make of makes) {
            const success = await clickMakeCheckbox(page, make);

            if (!success) {
                console.log(`  ❌ Could not click ${make}`);

                const availableMakes = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('button[role="checkbox"][id^="FILTER.MAKE_MODEL."]'))
                        .map((button) => ({
                            id: button.id,
                            ariaLabel: button.getAttribute('aria-label'),
                            checked: button.getAttribute('aria-checked'),
                            visibleText: button.closest('li')?.textContent?.trim(),
                        }));
                });

                console.log(`  🔎 Available makes: ${JSON.stringify(availableMakes)}`);
                return false; // Stop immediately, don't burn 90s on every remaining make
            }

            await page.waitForTimeout(800);
        }

        await page.waitForTimeout(2500); // Wait for results to update
        return true;
    } catch (error) {
        console.log(`  ❌ Make filter failed: ${error.message}`);
        return false;
    }
}

async function applyPriceFilter(page) {
    try {
        console.log(`💰 Setting minimum price to: $35,000 CAD`);

        await ensureAccordionOpen(page, '#Price-accordion-trigger', '#Price-accordion-content', 'Price');

        // Find the MINIMUM slider specifically (not maximum)
        const minSlider = page.locator('[role="slider"][aria-label="Minimum"]');
        await minSlider.waitFor({ state: 'visible', timeout: 90000 });

        // Click on the minimum slider to focus it
        await minSlider.click({ timeout: 90000 });
        await page.waitForTimeout(500);

        // Set the slider value to 24 (which equals $35,000 CAD)
        // Using keyboard arrow keys: press Home to go to 0, then Right arrow 24 times
        await page.keyboard.press('Home'); // Reset to 0
        await page.waitForTimeout(300);

        // Press Right arrow 24 times to reach position 24 ($35,000)
        for (let i = 0; i < 24; i++) {
            await page.keyboard.press('ArrowRight');
            await page.waitForTimeout(50); // Small delay between presses
        }

        console.log(`  ✅ Minimum price set to $35,000`);
        await page.waitForTimeout(2000); // Wait for results to update
        return true;

    } catch (error) {
        console.log(`  ❌ Price filter failed: ${error.message}`);
        return false;
    }
}

async function applyDealRatingFilter(page, dealRatings) {
    try {
        console.log(`⭐ Setting deal ratings: ${dealRatings.join(', ')}`);

        await ensureAccordionOpen(page, '#DealRating-accordion-trigger', '#DealRating-accordion-content', 'Deal Rating');

        // Click checkboxes for each deal rating
        for (const rating of dealRatings) {
            try {
                // Click with 6-minute timeout
                await page.click(`#FILTER\\.DEAL_RATING\\.${rating}`, { timeout: 90000 });
                console.log(`  ✅ Added ${rating.replace('_', ' ')}`);
                await page.waitForTimeout(300);
            } catch (error) {
                console.log(`  ❌ Could not click ${rating}: ${error.message}`);
                return false;
            }
        }

        await page.waitForTimeout(2000); // Wait for results to update
        return true;
    } catch (error) {
        console.log(`  ❌ Deal rating filter failed: ${error.message}`);
        return false;
    }
}

// ============================================
// MAIN SCRAPER
// ============================================

// ============================================
// DIAGNOSTICS
// Capture what the SCRAPER actually sees — from every angle — so we can tell
// whether CarGurus is serving us a broken/bot-mitigated page vs the smooth
// one a human gets. Saves a screenshot + full HTML + a structured signals
// JSON to the default key-value store, and prints an at-a-glance summary.
// ============================================
async function captureDiagnostics(page, label) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const tag = `diag-${label}-${ts}`;

    let signals = {};
    try {
        signals = await page.evaluate(() => {
            const html = document.documentElement.outerHTML;
            const bodyText = document.body ? (document.body.innerText || '') : '';
            const has = (re) => re.test(html);
            return {
                url: location.href,
                title: document.title,
                readyState: document.readyState,
                webdriver: navigator.webdriver,
                userAgent: navigator.userAgent,
                languages: navigator.languages,
                pluginCount: navigator.plugins ? navigator.plugins.length : 0,
                htmlLength: html.length,
                bodyTextLength: bodyText.length,
                // Did the filter panel actually render?
                distanceSelect: !!document.querySelector('select[aria-label="Distance from me"], select[data-testid="select-filter-distance"]'),
                bodyTrigger: !!document.querySelector('#BodyStyle-accordion-trigger'),
                bodyContentState: (document.querySelector('#BodyStyle-accordion-content') || {}).getAttribute
                    ? document.querySelector('#BodyStyle-accordion-content').getAttribute('data-state') : null,
                bodyCheckboxes: document.querySelectorAll('button[role="checkbox"][id^="FILTER.BODY_TYPE_GROUP."]').length,
                makeCheckboxes: document.querySelectorAll('button[role="checkbox"][id^="FILTER.MAKE_MODEL."]').length,
                accordionTriggers: Array.from(document.querySelectorAll('[id$="-accordion-trigger"]')).map((e) => e.id),
                filterButtons: Array.from(document.querySelectorAll('button'))
                    .map((b) => (b.textContent || '').trim())
                    .filter((t) => /^filters?$/i.test(t) || /show filters|all filters/i.test(t))
                    .slice(0, 5),
                // Bot-wall / challenge fingerprints in the served HTML/text
                datadome: has(/datadome/i),
                perimeterx: has(/perimeterx|px-captcha|_pxhd|window\._px/i),
                cloudflare: has(/cf-challenge|cf_chl|challenge-platform|cf-turnstile/i),
                akamai: has(/ak_bmsc|akam|_abck/i),
                recaptcha: has(/recaptcha/i),
                hcaptcha: has(/hcaptcha/i),
                challengeText: /unusual traffic|are you a robot|verify (you|your)|access (to this page has been )?denied|you have been blocked|captcha|pardon our interruption|before we continue|checking your browser/i.test(bodyText),
                bodyTextSample: bodyText.replace(/\s+/g, ' ').trim().slice(0, 600),
            };
        });
    } catch (e) {
        signals = { error: `page.evaluate failed: ${e.message}` };
    }

    // httpOnly bot cookies (datadome/_abck/px…) aren't in document.cookie — read
    // them from the browser context instead.
    try {
        const names = (await page.context().cookies()).map((c) => c.name);
        signals.cookieNames = names;
        signals.botCookies = names.filter((n) => /datadome|_abck|ak_bmsc|_px|px[_-]|__cf|cf_|incap_|visid|reese84/i.test(n));
    } catch (_) {}

    // Persist the three artifacts.
    try {
        await Actor.setValue(`${tag}.png`, await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
    } catch (e) { console.log(`  ⚠️ diag screenshot failed: ${e.message}`); }
    try {
        await Actor.setValue(`${tag}.html`, await page.content(), { contentType: 'text/html; charset=utf-8' });
    } catch (e) { console.log(`  ⚠️ diag html failed: ${e.message}`); }
    try {
        // No contentType: Actor.setValue auto-serializes a plain object to JSON.
        // (Passing contentType requires a String/Buffer, which is why it errored.)
        await Actor.setValue(`${tag}.json`, signals);
    } catch (e) { console.log(`  ⚠️ diag json failed: ${e.message}`); }

    // At-a-glance console verdict.
    console.log(`  🔬 DIAG [${label}] → saved ${tag}.png / .html / .json`);
    console.log(`     url=${signals.url}`);
    console.log(`     title="${signals.title}" ready=${signals.readyState} webdriver=${signals.webdriver} htmlLen=${signals.htmlLength} bodyTextLen=${signals.bodyTextLength}`);
    console.log(`     panel: distanceSelect=${signals.distanceSelect} bodyTrigger=${signals.bodyTrigger} bodyContentState=${signals.bodyContentState} bodyCheckboxes=${signals.bodyCheckboxes} makeCheckboxes=${signals.makeCheckboxes}`);
    console.log(`     accordions=${JSON.stringify(signals.accordionTriggers)} filterButtons=${JSON.stringify(signals.filterButtons)}`);
    console.log(`     bot: challengeText=${signals.challengeText} datadome=${signals.datadome} px=${signals.perimeterx} cf=${signals.cloudflare} akamai=${signals.akamai} recaptcha=${signals.recaptcha} hcaptcha=${signals.hcaptcha}`);
    console.log(`     botCookies=${JSON.stringify(signals.botCookies || [])}`);
    if (signals.challengeText || signals.bodyTrigger === false) {
        console.log(`     ⚠️ bodyTextSample: ${JSON.stringify(signals.bodyTextSample)}`);
    }
    return signals;
}

await Actor.main(async () => {
    const input = await Actor.getInput();
    // Diagnostics are ON unless the run input explicitly sets debug:false.
    const debug = !input || input.debug !== false;

    // Wire the Apify proxy from input into the ACTUAL browser. It was defined in
    // input all along but never applied in code, so every request egressed from
    // Apify's data-center IP — which CarGurus geolocated to the US (zip 20149 /
    // Ashburn VA) and answered with a 0-results "Error" page on the .ca search.
    // A residential CA IP gives a Canadian zip and real inventory.
    const proxyConfiguration = await Actor.createProxyConfiguration(input?.proxyConfiguration);
    console.log(proxyConfiguration
        ? `🛡️ Proxy configured: ${JSON.stringify(input.proxyConfiguration)}`
        : '⚠️ No proxy configured — egressing on the actor\'s direct (data-center) IP');

    const {
        searchRadius = 50000,
        currentPage = null,
        maxPages = 73,
        maxResults = 24,
        filters = {
            makes: ['Ford', 'GMC', 'Chevrolet', 'Cadillac'],
            bodyTypes: ['SUV / Crossover', 'Pickup Truck'],
            maxMileage: 140000,
            minPrice: 35000,
            dealRatings: ['GREAT_PRICE', 'GOOD_PRICE', 'FAIR_PRICE']
        }
    } = input;

    console.log('🚀 Starting CarGurus Stealth Scraper with UI Filters...');

    // Open persistent Key-Value Store (survives between runs)
    const kv = await Actor.openKeyValueStore('scraper-state');

    // Get or initialize page state with daily reset
    let startPage = currentPage;
    if (!startPage) {
        const state = await kv.getValue('state') || {};
        const today = new Date().toISOString().split('T')[0]; // "2025-11-13"

        // Check if we need to reset (new day or first run)
        if (state.lastScrapedDate === today) {
            // Same day → continue from where we left off
            startPage = state.nextPage || 1;

            // If we've exceeded maxPages, restart from page 1
            if (startPage > maxPages) {
                startPage = 1;
                console.log(`📅 All pages completed! Restarting from page 1 (same day: ${today})`);
            } else {
                console.log(`📅 Continuing from page ${startPage} (same day: ${today})`);
            }
        } else {
            // Different day or first run → reset to page 1
            startPage = 1;
            if (state.lastScrapedDate) {
                console.log(`📅 New day detected! Resetting to page 1 (previous: ${state.lastScrapedDate}, today: ${today})`);
            } else {
                console.log(`📅 First run! Starting from page 1`);
            }
        }
    }

    // Calculate the 3-page batch
    const pagesToScrape = [];
    for (let i = 0; i < 3; i++) {
        const pageNum = startPage + i;
        if (pageNum <= maxPages) {
            pagesToScrape.push(pageNum);
        }
    }

    // Safety check
    if (pagesToScrape.length === 0) {
        console.log(`✅ All pages scraped! (Last page: ${maxPages})`);
        return;
    }

    console.log(`📄 Scraping ${pagesToScrape.length} pages this run: ${pagesToScrape.join(', ')} of ${maxPages} total`);
    console.log(`🌍 Search radius: ${searchRadius === 50000 ? 'Nationwide' : searchRadius + ' km'}`);
    console.log(`📊 Max results per page: ${maxResults}`);

    const baseUrl = 'https://www.cargurus.ca/Cars/l-Used-SUV-Crossover-bg7';

    // Launch browser, apply filters — full restart on failure (up to 3 attempts)
    let browser, context, page;
    let filtersSucceeded = false;

    for (let filterAttempt = 1; filterAttempt <= 3; filterAttempt++) {
        // Fresh browser every attempt
        if (browser) {
            await browser.close().catch(() => {});
        }

        console.log(`\n🔄 Starting fresh browser (attempt ${filterAttempt}/3)...`);

        // Fresh residential IP each attempt (new proxy session) so one bad exit
        // node doesn't sink all three tries.
        let launchProxy;
        if (proxyConfiguration) {
            const sessionId = `cg${Date.now().toString(36)}${filterAttempt}`;
            const proxyUrl = await proxyConfiguration.newUrl(sessionId);
            const u = new URL(proxyUrl);
            launchProxy = {
                server: `${u.protocol}//${u.host}`,
                username: decodeURIComponent(u.username),
                password: decodeURIComponent(u.password),
            };
            console.log(`  🛡️ Proxy for this attempt: ${u.host} (session ${sessionId})`);
        }

        browser = await chromium.launch({
            headless: true,
            proxy: launchProxy,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor',
            ],
        });

        context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale: 'en-CA',
            timezoneId: 'America/Toronto',
            geolocation: { longitude: -79.3832, latitude: 43.6532 },
            permissions: ['geolocation'],
        });

        page = await context.newPage();

        // Prove the egress IP/geo actually changed — this is the smoking-gun
        // check. Want to see a Canadian city here, not Ashburn/Virginia/US.
        try {
            const ipResp = await context.request.get('https://ipinfo.io/json', { timeout: 10000 });
            const ip = await ipResp.json();
            console.log(`  🌍 Egress IP: ${ip.ip} — ${ip.city || '?'}, ${ip.region || '?'}, ${ip.country || '?'}`);
        } catch (e) {
            console.log(`  ⚠️ Egress IP check failed: ${e.message}`);
        }

        try {
            console.log(`\n🌐 Visiting base page: ${baseUrl}`);
            const navResponse = await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
            console.log(`  🌐 HTTP status: ${navResponse ? navResponse.status() : 'n/a'} (final URL: ${page.url()})`);

            console.log('⏳ Waiting for page to load...');
            await page.waitForTimeout(5000);

            console.log('🖱️ Simulating human behavior...');
            await page.mouse.move(100, 200);
            await page.waitForTimeout(500);
            await page.mouse.move(300, 400);
            await page.waitForTimeout(1000);

            // Baseline: capture exactly what the scraper sees on arrival, every
            // attempt, so we can compare a good load vs a bad one.
            if (debug) await captureDiagnostics(page, `attempt${filterAttempt}-postload`);

            const result = await applyFilters(page, filters, searchRadius);

            if (result) {
                filtersSucceeded = true;
                break;
            }

            // Filters failed — snapshot the exact failed state (which step failed
            // is visible in the log lines just above this).
            if (debug) await captureDiagnostics(page, `attempt${filterAttempt}-FAILED`);
        } catch (e) {
            console.log(`  ❌ Browser attempt ${filterAttempt} crashed: ${e.message}`);
            if (debug) {
                try { await captureDiagnostics(page, `attempt${filterAttempt}-CRASH`); } catch (_) {}
            }
        }

        if (filterAttempt < 3) {
            console.log(`⚠️ Filter attempt ${filterAttempt}/3 failed — closing browser and starting fresh...`);
        } else {
            console.log(`❌ All 3 filter attempts failed — aborting run`);
        }
    }

    if (!filtersSucceeded) {
        if (browser) await browser.close().catch(() => {});
        console.log('🛑 Could not apply filters after 3 attempts. Will retry on next scheduled run.');
        return;
    }

    try {
        // STEP 3: Get the filtered URL with searchId
        const filteredUrl = page.url();
        const baseUrlWithFilters = filteredUrl.split('#')[0];

        console.log(`✅ Filters applied! Generated URL with searchId`);

        // Track current page (we start at page 1 after applying filters)
        let currentPageNumber = 1;

        // STEP 4-7: Loop through each page in the batch (3 pages)
        for (const pageToScrape of pagesToScrape) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`📄 Processing page ${pageToScrape} of ${maxPages}`);
            console.log(`${'='.repeat(60)}\n`);

            // Navigate to specific page if needed by clicking Next button (human-like)
            if (pageToScrape !== currentPageNumber) {
                const clicksNeeded = pageToScrape - currentPageNumber;
                console.log(`🔄 Navigating from page ${currentPageNumber} to page ${pageToScrape} (${clicksNeeded} clicks)...`);

                for (let i = 0; i < clicksNeeded; i++) {
                    try {
                        // Scroll to bottom to make pagination visible
                        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                        await page.waitForTimeout(800);

                        // Wait for and click the Next button (2-minute timeout)
                        const nextButton = page.locator('button[data-testid="srp-desktop-page-navigation-next-page"]');
                        await nextButton.waitFor({ state: 'visible', timeout: 120000 });
                        await nextButton.click({ timeout: 120000 });

                        console.log(`  ✅ Clicked Next button (${i + 1}/${clicksNeeded})`);

                        // Wait for new page to load
                        await page.waitForTimeout(4000);
                    } catch (error) {
                        console.log(`  ⚠️ Next button click failed: ${error.message}`);
                        // Fallback to hash navigation if Next button fails
                        console.log(`  🔄 Falling back to hash navigation...`);
                        await page.evaluate((pageNum) => {
                            window.location.hash = `resultsPage=${pageNum}`;
                        }, pageToScrape);
                        await page.waitForTimeout(5000);
                        break; // Exit the clicking loop since we used hash navigation
                    }
                }

                // Scroll to top after navigation
                await page.evaluate(() => window.scrollTo(0, 0));
                await page.waitForTimeout(1000);

                // Update current page tracker
                currentPageNumber = pageToScrape;
            }

            // Scroll to load car links
            console.log('📜 Scrolling to load content...');
            for (let i = 0; i < 3; i++) {
                await page.evaluate((offset) => {
                    window.scrollTo({
                        top: offset,
                        behavior: 'smooth'
                    });
                }, (i + 1) * 1000);
                await page.waitForTimeout(2000);
            }

            await page.waitForTimeout(3000);

            // Count available car listings
            const totalListings = await page.evaluate(() => {
                return document.querySelectorAll('a[data-testid="car-blade-link"]').length;
            });

            console.log(`🚗 Found ${totalListings} car listings on page ${pageToScrape}`);

            // Debug if no links found
            if (totalListings === 0) {
                console.log('⚠️ No car listings found - debugging...');
                const currentUrl = page.url();
                const pageTitle = await page.title();
                console.log(`📍 Current URL: ${currentUrl}`);
                console.log(`📄 Page title: ${pageTitle}`);

                await Actor.setValue(`debug-screenshot-page${pageToScrape}.png`, await page.screenshot({ fullPage: false }), { contentType: 'image/png' });
                continue; // Skip to next page
            }

            // Process listings by clicking them (SPA-compatible)
            const listingsToProcess = Math.min(totalListings, maxResults);
            console.log(`📋 Will process ${listingsToProcess} car listings`);

        for (let listingIndex = 0; listingIndex < listingsToProcess; listingIndex++) {
            console.log(`\n🔍 Processing listing ${listingIndex + 1}/${listingsToProcess}...`);

            let listingPage = null;
            try {
                // Get listing URL from main search tab (which stays open the whole time)
                const listingHref = await page.evaluate((index) => {
                    const links = document.querySelectorAll('a[data-testid="car-blade-link"]');
                    return links[index] ? links[index].href : null;
                }, listingIndex);

                if (!listingHref) {
                    console.log(`  ⚠️ Listing ${listingIndex + 1} not found in DOM - skipping`);
                    continue;
                }

                // Open listing in a new tab — search results tab stays untouched
                listingPage = await context.newPage();
                await listingPage.goto(listingHref, { waitUntil: 'domcontentloaded', timeout: 90000 });
                await listingPage.waitForSelector('h1[data-cg-ft="vdp-listing-title"]', { timeout: 15000 });
                console.log(`  ✅ Detail page loaded`);

                // Small delay to let detail view fully render
                await listingPage.waitForTimeout(2000);

                // Extract data from the listing tab
                const carData = await listingPage.evaluate(() => {
                    const preflight = window.__PREFLIGHT__ || {};
                    const listing = preflight.listing || {};

                    const getFieldText = (fieldName) => {
                        const container = document.querySelector(`[data-cg-ft="${fieldName}"]`);

                        if (container) {
                            const spans = Array.from(container.querySelectorAll('span'))
                                .map((span) => span.textContent.trim())
                                .filter(Boolean);

                            if (spans.length > 0) {
                                return spans[spans.length - 1];
                            }
                        }

                        const legacyValue = document.querySelector(`div[data-cg-ft="${fieldName}"] span[class*="_value_"]`);
                        return legacyValue ? legacyValue.textContent.trim() : null;
                    };

                    const getPriceText = () => {
                        const selectors = [
                            'div[data-cg-ft="price"] h2',
                            'div[data-cg-ft="price"] [data-testid]',
                            'div[class*="_price_"] h2',
                            'h2[class*="price"]',
                        ];

                        for (const selector of selectors) {
                            const element = document.querySelector(selector);
                            const text = element ? element.textContent.trim() : null;
                            if (text) return text;
                        }

                        return null;
                    };

                    let vin = getFieldText('vin') || listing.vin || null;
                    if (!vin && listing.specs) {
                        const vinSpec = listing.specs.find(s => s.label && s.label.toLowerCase() === 'vin');
                        if (vinSpec) vin = vinSpec.value;
                    }

                    let fuelType = getFieldText('fuelType');
                    if (!fuelType && listing.specs) {
                        const fuelSpec = listing.specs.find(s =>
                            s.label && (s.label.toLowerCase().includes('fuel') || s.label.toLowerCase().includes('engine'))
                        );
                        if (fuelSpec) fuelType = fuelSpec.value;
                    }

                    const titleEl = document.querySelector('h1[data-cg-ft="vdp-listing-title"]');
                    const title = titleEl ? titleEl.textContent.trim() : '';

                    const priceText = getPriceText();
                    const priceValue = priceText ? parseInt(priceText.replace(/[$,]/g, '')) : null;

                    const dealerNameEl = document.querySelector('[data-testid="dealerName"]');
                    const locationFromTitle = document.querySelector('hgroup p.fIarB.SlqY9');
                    const dealerAddressEl = document.querySelector('[data-testid="dealerAddress"] span[data-track-ui="dealer-address"]');

                    return {
                        vin,
                        title: title || preflight.listingTitle,
                        price: priceValue || preflight.listingPriceValue || listing.price,
                        priceString: priceText || preflight.listingPriceString || listing.priceString,
                        year: getFieldText('year') || listing.year || preflight.listingYear,
                        make: getFieldText('make') || listing.make || preflight.listingMake,
                        model: getFieldText('model') || listing.model || preflight.listingModel,
                        trim: getFieldText('trim') || listing.trim,
                        mileage: getFieldText('mileage') || listing.mileage || listing.odometer,
                        dealerName: dealerNameEl ? dealerNameEl.textContent.trim() : (listing.dealerName || preflight.listingSellerName),
                        dealerCity: locationFromTitle ? locationFromTitle.textContent.trim() : (listing.dealerCity || preflight.listingSellerCity),
                        dealerAddress: dealerAddressEl ? dealerAddressEl.textContent.trim() : null,
                        dealRating: listing.dealRating || listing.dealBadge,
                        bodyType: getFieldText('bodyType') || listing.bodyType,
                        fuelType: fuelType,
                        url: window.location.href,
                        source: 'dom',
                        hasApiData: false
                    };
                });

                // Close the listing tab — back to search results automatically
                await listingPage.close();
                listingPage = null;
                console.log(`  ✅ Listing tab closed`);

                // Add page metadata
                carData.pageNumber = pageToScrape;
                carData.searchRadius = searchRadius;

                console.log(`  VIN: ${carData.vin || 'NOT FOUND'}`);
                console.log(`  Title: ${carData.title || 'NOT FOUND'}`);
                console.log(`  Price: ${carData.priceString || carData.price || 'NOT FOUND'}`);
                console.log(`  Year: ${carData.year || 'NOT FOUND'}`);
                console.log(`  Mileage: ${carData.mileageString || carData.mileage || 'NOT FOUND'}`);
                console.log(`  Body Type: ${carData.bodyType || 'NOT FOUND'}`);
                console.log(`  Fuel Type: ${carData.fuelType || 'NOT FOUND'}`);
                console.log(`  Dealer: ${carData.dealerName || 'NOT FOUND'} - ${carData.dealerCity || 'NOT FOUND'}`);
                console.log(`  Source: ${carData.source}`);

                // Save car data
                if (carData.vin || carData.title) {
                    const sourceScraper = pageToScrape >= 1 && pageToScrape <= 6
                        ? 'Best 3-pager'
                        : 'Best';

                    const dataToSave = {
                        type: 'car_listing',
                        ...carData,
                        scrapedAt: new Date().toISOString(),
                        source_scraper: sourceScraper
                    };

                    await Actor.pushData(dataToSave);
                    console.log(`  ✅ Saved to dataset`);

                    try {
                        const webhookUrl = 'https://n8nsaved-production.up.railway.app/webhook/cargurus';
                        const response = await fetch(webhookUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(dataToSave)
                        });
                        if (response.ok) {
                            console.log(`  📤 Sent to webhook (${response.status})`);
                        } else {
                            console.log(`  ⚠️ Webhook failed: ${response.status}`);
                        }
                    } catch (webhookError) {
                        console.log(`  ⚠️ Webhook error: ${webhookError.message}`);
                    }
                } else {
                    console.log(`  ⚠️ No data found - skipping`);
                }

                // Random delay between cars
                await page.waitForTimeout(2000 + Math.random() * 3000);

            } catch (error) {
                console.error(`❌ Error processing listing ${listingIndex + 1}:`, error.message);
                if (listingPage) {
                    await listingPage.close().catch(() => {});
                    listingPage = null;
                }
            }
        }

            // Save state after each page completes (more resilient to crashes)
            const nextPage = pageToScrape + 1;
            const today = new Date().toISOString().split('T')[0];

            await kv.setValue('state', {
                nextPage,
                lastScrapedDate: today,
                baseUrl: baseUrlWithFilters,
                searchRadius,
                lastScraped: new Date().toISOString(),
                lastPage: pageToScrape,
                pagesScraped: pagesToScrape.slice(0, pagesToScrape.indexOf(pageToScrape) + 1)
            });

            console.log(`💾 State saved: Page ${pageToScrape} complete. Next run will start at page ${nextPage} (date: ${today})`);

        } // End of page loop

    } catch (error) {
        console.error(`❌ Error processing pages ${pagesToScrape.join(', ')}:`, error.message);
    }

    await browser.close();
    console.log('\n✅ Scraping complete!');
});
