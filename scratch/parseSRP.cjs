const fs = require('fs');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

const html = fs.readFileSync('scratch/sample.html', 'utf8');
const dom = new JSDOM(html);
const document = dom.window.document;
const element = document.querySelector('div');

function extractFromSRP(element) {
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

    const linkEl = element.querySelector('a[data-testid="tile-link"], a[data-testid="car-blade-link"]');
    if (linkEl) data.url = linkEl.href;
    
    const mileageEl = element.querySelector('[data-testid="srp-tile-mileage"]');
    if (mileageEl && !data.mileage) data.mileage = mileageEl.textContent.trim();

    return data;
}

console.log(extractFromSRP(element));
