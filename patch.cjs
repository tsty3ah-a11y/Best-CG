const fs = require('fs');

const path = 'src/main.js';
let content = fs.readFileSync(path, 'utf8');

const target1 = `            let listingPage = null;
            try {
                // Get listing URL from main search tab (which stays open the whole time)
                const listingHref = await page.evaluate(({ index, sel }) => {
                    const links = document.querySelectorAll(sel);
                    return links[index] ? links[index].href : null;
                }, { index: listingIndex, sel: listingSelector });

                if (!listingHref) {
                    console.log(\`  ⚠️ Listing \${listingIndex + 1} not found in DOM - skipping\`);
                    continue;
                }

                // Open listing in a new tab — search results tab stays untouched
                listingPage = await context.newPage();
                await listingPage.goto(listingHref, { waitUntil: 'domcontentloaded', timeout: 90000 });
                await listingPage.waitForSelector('h1[data-cg-ft="vdp-listing-title"]', { timeout: 15000 });
                console.log(\`  ✅ Detail page loaded\`);

                // Small delay to let detail view fully render
                await listingPage.waitForTimeout(2000);

                // Extract data from the listing tab
                const carData = await listingPage.evaluate(() => {`;

const repl1 = `            try {
                // Extract directly from the SRP list item without opening a new tab
                const srpData = await page.evaluate(({ index, sel }) => {
                    const links = document.querySelectorAll(sel);
                    const link = links[index];
                    if (!link) return null;
                    
                    const element = link.closest('[data-testid="srp-listing-tile"]') || link.closest('div[class*="blade"]') || link.parentElement.parentElement;
                    const data = {};
                    
                    const dl = element.querySelector('dl');
                    if (dl) {
                        const dts = dl.querySelectorAll('dt');
                        const dds = dl.querySelectorAll('dd');
                        for (let i = 0; i < dts.length; i++) {
                            const key = dts[i].textContent.trim().replace(':', '').toLowerCase();
                            const value = dds[i] ? dds[i].textContent.trim() : null;
                            if (key === 'vin') data.vin = value;
                            if (key === 'year') data.year = value;
                            if (key === 'make') data.make = value;
                            if (key === 'model') data.model = value;
                            if (key === 'body type') data.bodyType = value;
                            if (key === 'fuel type') data.fuelType = value;
                            if (key === 'mileage') data.mileage = value;
                            if (key === 'doors') data.doors = value;
                            if (key === 'drivetrain') data.drivetrain = value;
                            if (key === 'engine') data.engine = value;
                            if (key === 'exterior colour' || key === 'exterior color') data.exteriorColor = value;
                            if (key === 'interior colour' || key === 'interior color') data.interiorColor = value;
                            if (key === 'transmission') data.transmission = value;
                        }
                    }

                    const titleEl = element.querySelector('[data-testid="srp-listing-blade-title"]');
                    if (titleEl) data.title = titleEl.textContent.trim();

                    const priceEl = element.querySelector('[data-testid="srp-tile-price"], [data-cg-ft="srp-listing-blade-price"]');
                    if (priceEl) {
                        data.priceString = priceEl.textContent.trim();
                        data.price = parseInt(data.priceString.replace(/[$,]/g, ''));
                    }

                    const trimEl = element.querySelector('[data-cg-ft="vehicle"]');
                    if (trimEl) data.trim = trimEl.textContent.trim();

                    const locationEl = element.querySelector('[data-testid="LocationSection-firstLine"] span, [data-testid="srp-tile-location-section"] span');
                    if (locationEl) data.dealerCity = locationEl.textContent.trim();

                    const sponsoredEl = element.querySelector('[data-testid="sponsored-text"] em');
                    if (sponsoredEl) {
                        data.dealerName = sponsoredEl.textContent.trim();
                    } else {
                        const logoImg = element.querySelector('[class*="dealerLogo"]');
                        if (logoImg && logoImg.alt) {
                            data.dealerName = logoImg.alt.trim();
                        }
                    }

                    const dealRatingEl = element.querySelector('[data-testid="srp-tile-deal-rating"] section span:not(:empty)');
                    if (dealRatingEl) data.dealRating = dealRatingEl.textContent.trim();

                    data.url = link.href;
                    
                    const mileageEl = element.querySelector('[data-testid="srp-tile-mileage"]');
                    if (mileageEl && !data.mileage) data.mileage = mileageEl.textContent.trim();
                    
                    data.source = 'srp_dom';

                    return data;
                }, { index: listingIndex, sel: listingSelector });

                if (!srpData) {
                    console.log(\`  ⚠️ Listing \${listingIndex + 1} not found in DOM - skipping\`);
                    continue;
                }

                let carData = srpData;
                let listingPage = null;

                // Fallback to detail page only if VIN is missing from SRP
                if (!carData.vin) {
                    console.log(\`  ⚠️ VIN missing from SRP, falling back to Detail Page...\`);
                    listingPage = await context.newPage();
                    await listingPage.goto(carData.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
                    
                    // Don't wait strictly for the h1 selector since it might be missing
                    await listingPage.waitForTimeout(3000); 
                    console.log(\`  ✅ Detail page loaded\`);

                    const vdpData = await listingPage.evaluate(() => {`;

const target2 = `                });

                // Close the listing tab — back to search results automatically
                await listingPage.close();
                listingPage = null;
                console.log(\`  ✅ Listing tab closed\`);`;

const repl2 = `                });

                await listingPage.close();
                listingPage = null;
                console.log(\`  ✅ Listing tab closed\`);
                
                carData = { ...srpData, ...vdpData, source: 'vdp_dom' };
                } else {
                    console.log(\`  ✅ Extracted fully from SRP (no detail page needed)\`);
                }`;

if (!content.includes(target1)) {
    console.error("Target 1 not found!");
    process.exit(1);
}
if (!content.includes(target2)) {
    console.error("Target 2 not found!");
    process.exit(1);
}

content = content.replace(target1, repl1);
content = content.replace(target2, repl2);

fs.writeFileSync(path, content, 'utf8');
console.log("Successfully patched main.js");
