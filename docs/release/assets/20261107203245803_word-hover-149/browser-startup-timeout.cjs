const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const launch = chromium.launch.bind(chromium);
chromium.launch = async (...arguments) => {
    const browser = await launch(...arguments);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...options) => {
        const context = await newContext(...options);
        context.setDefaultTimeout(60000);
        context.setDefaultNavigationTimeout(60000);
        return context;
    };
    return browser;
};
