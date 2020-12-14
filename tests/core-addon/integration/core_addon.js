/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const archiver = require("archiver");
const firefox = require("selenium-webdriver/firefox");
const fs = require("fs");
const { Builder, By, until } = require("selenium-webdriver");
const os = require("os");
const path = require("path");

// The number of milliseconds to wait for some
// property to change in tests. This should be
// a long time to account for slow CI.
const WAIT_FOR_PROPERTY = 5000;

const firefoxOptions = new firefox.Options();
firefoxOptions.setPreference("xpinstall.signatures.required", false);
firefoxOptions.setPreference("extensions.experiments.enabled", true);
// Unset this to run the UI (useful for local testing).
firefoxOptions.headless();

// This is the path to Firefox Nightly on Ubuntu with the Mozilla PPA.
if (process.platform === "linux") {
  firefoxOptions.setBinary("/usr/bin/firefox");
} else if (process.platform === "darwin") {
  firefoxOptions.setBinary(
    "/Applications/Firefox Nightly.app/Contents/MacOS/firefox"
  );
}

/**
 * Find the element and perform an action on it.
 *
 * @param driver
 *        The Selenium driver to use.
 * @param element
 *        The element to look for and execute actions on.
 * @param action
 *        A function in the form `e => {}` that will be called
 *        and receive the element once ready.
 */
async function findAndAct(driver, element, action) {
  await driver.wait(until.elementLocated(element), WAIT_FOR_PROPERTY);
  await driver.findElement(element).then(e => action(e));
}

/**
 * Get a temporary directory.
 *
 * @returns {String} the path to a temporary directory.
 */
async function getTempDirectory() {
  return await new Promise((resolve, reject) => fs.mkdtemp(
      path.join(os.tmpdir(), 'rally-test-'),
      (err, directory) => {
        if (err) {
          reject(err);
        }
        resolve(directory);
      }
    )
  );
}

/**
 * Generate a Rally test study add-on.
 *
 * @param {String} directory
 *        The directory in which to create the add-on file.
 *
 * @return {String} the full path of the addon file.
 */
async function generateTestStudyAddon(directory) {
  let tempFile =
    path.join(directory, "test-rally-study.xpi");

  var output = fs.createWriteStream(tempFile);
  var archive = archiver("zip");
  archive.on("error", err => { throw err; });
  archive.pipe(output);

  // Add the manifest file.
  archive.append(Buffer.from(`
{
  "manifest_version": 2,
  "name": "Rally Integration Test Add-on",
  "version": "1.0",

  "applications": {
    "gecko": {
      "id": "rally-integration-test@mozilla.org",
      "strict_min_version": "84.0a1"
    }
  },

  "permissions": [],

  "background": {
    "scripts": [
      "rally.js",
      "background.js"
    ]
  }
}
`), { name: "manifest.json" });

  // Add the background.js script.
  archive.append(Buffer.from(`
const rally = new Rally();

rally.initialize(
  // A sample key id used for encrypting data.
  "sample-invalid-key-id",
  // A sample *valid* JWK object for the encryption.
  {
    "kty":"EC",
    "crv":"P-256",
    "x":"f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
    "y":"x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
    "kid":"Public key used in JWS spec Appendix A.3 example"
  }
);`), { name: "background.js" });

  // Add the Rally support library.
  const rallySupport = "./support/rally.js";
  archive.append(
    fs.createReadStream(rallySupport), { name: 'rally.js' });

  // Build the addon archive.
  archive.finalize();

  return tempFile;
}

/**
 * TODO
 *
 * @param direct
 */
async function generateAddonInstallPage(directory, addonPath, options={}) {
  let filename = (!!options.filename) ? options.filename : "index.html";
  let pageTitle = (!!options.pageTitle) ? options.pageTitle : "Installation Test";
  let destinationPath = path.join(directory, filename);
  let content =
    `<html><title>${pageTitle}</title><a id="install" href="${addonPath}">Install</a></html>`;

  return await new Promise((resolve, reject) => {
    fs.writeFile(destinationPath, content, err => {
      if (err) {
        reject(err);
      }
      resolve(destinationPath);
    });
  });
}

describe("Core-Addon Onboarding", function () {
  // eslint-disable-next-line mocha/no-hooks-for-single-case
  beforeEach(async function () {
    this.driver = await new Builder()
      .forBrowser("firefox")
      .setFirefoxOptions(firefoxOptions)
      .build();
  });

  // eslint-disable-next-line mocha/no-hooks-for-single-case
  afterEach(async function () {
    await this.driver.quit();
  });

  it("should un/enroll in Rally", async function () {
    let tempDir = await getTempDirectory();
    let addonFile = await generateTestStudyAddon(tempDir);
    let pagePath = await generateAddonInstallPage(tempDir, addonFile);

    await this.driver.get(`file:///${pagePath}`);
    await this.driver.wait(until.titleIs("Installation Test"), WAIT_FOR_PROPERTY);
    await new Promise(r => setTimeout(r, 2000));
    await findAndAct(this.driver, By.id("install"), e => e.click());

    // switch to browser UI context, to interact with Firefox add-on install prompts.
    await this.driver.setContext(firefox.Context.CHROME);
    await new Promise(r => setTimeout(r, 2000));
    await this.driver.takeScreenshot().then(data => {
       var base64Data = data.replace(/^data:image\/png;base64,/,"")
       fs.writeFile("out.png", base64Data, 'base64', function(err) {
            if(err) console.log(err);
       });
    });
    await findAndAct(this.driver, By.css(`[label="Add"]`), e => e.click());
    await findAndAct(this.driver, By.css(`[label="Okay, Got It"]`), e => e.click());

    // Switch back to web content context.
    await this.driver.setContext(firefox.Context.CONTENT);

    // We expect the extension to load its options page in a new tab.
    await this.driver.wait(async () => {
      return (await this.driver.getAllWindowHandles()).length === 2;
    }, WAIT_FOR_PROPERTY);

    // Selenium is still focused on the old tab, so switch to the new window handle.
    const newTab = (await this.driver.getAllWindowHandles())[1];
    await this.driver.switchTo().window(newTab);

    // New tab is focused.
    await this.driver.wait(
      until.titleIs("Ion: Put your data to work for a better internet"),
      WAIT_FOR_PROPERTY
    );

    await this.driver.wait(until.elementLocated(By.css("button")));

    // FIXME we need to use button IDs here so xpath is not needed...
    // See https://github.com/mozilla-ion/ion-core-addon/issues/244
    await findAndAct(this.driver, By.xpath(`//button[text()="Get Started"]`), e => e.click());
    await findAndAct(this.driver, By.xpath(`//button[text()="Accept & Participate"]`), e => e.click());
    // TODO check that state is enrolled, see https://github.com/mozilla-ion/ion-core-addon/issues/245

    await findAndAct(this.driver, By.xpath(`//button[text()="Save & Continue"]`), e => e.click());

    await this.driver.wait(until.elementLocated(By.css("button")));
    await findAndAct(this.driver, By.xpath(`//button[text()="Join Study"]`), e => e.click());
    await findAndAct(this.driver, By.xpath(`(//button[text()="Join Study"])[2]`), e => e.click());

    // Switch to browser UI context, to interact with Firefox add-on install prompts.

    await this.driver.setContext(firefox.Context.CHROME);
    await findAndAct(this.driver, By.css(`[label="Continue to Installation"]`), e => e.click());

    await findAndAct(this.driver, By.css(`[label="Add"]`), e => e.click());
    await findAndAct(this.driver, By.css(`[label="Okay, Got It"]`), e => e.click());

    // FIXME close tab and click on icon, check that post-enrollment options page is shown.
    // This will currently fail because there is a bug in the core-addon UI, where
    // the options page will show no studies.
    // See https://github.com/mozilla-ion/ion-core-addon/issues/235

    // Switch back to web content context.
    await this.driver.setContext(firefox.Context.CONTENT);

    // Begin study unenrollment cancel it.
    await findAndAct(this.driver, By.xpath(`//button[text()="Leave Mozilla Rally"]`), e => e.click());

    await findAndAct(this.driver, By.xpath(`//button[text()="Cancel"]`), e => e.click());

    // Begin unenrollment and confirm it this time.
    await findAndAct(this.driver, By.xpath(`//button[text()="Leave Mozilla Rally"]`), e => e.click());

    await this.driver.wait(
      until.titleIs("Ion: Put your data to work for a better internet"),
      WAIT_FOR_PROPERTY
    );

    await findAndAct(this.driver, By.xpath(`//button[text()="Leave Rally"]`), e => e.click());
    // TODO check that core add-on is uninstalled, see https://github.com/mozilla-ion/ion-core-addon/issues/245
  });
});
