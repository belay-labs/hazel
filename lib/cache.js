// Packages
const fetch = require("node-fetch");
const retry = require("async-retry");
const convertStream = require("stream-to-string");
const ms = require("ms");
const semver = require("semver");

// Utilities
const checkPlatform = require("./platform");

module.exports = class Cache {
  constructor(config) {
    const { account, repository, token, url } = config;
    this.config = config;

    if (!account || !repository) {
      const error = new Error("Neither ACCOUNT, nor REPOSITORY are defined");
      error.code = "missing_configuration_properties";
      throw error;
    }

    if (token && !url) {
      const error = new Error(
        "Neither VERCEL_URL, nor URL are defined, which are mandatory for private repo mode",
      );
      error.code = "missing_configuration_properties";
      throw error;
    }

    this.latest = {};
    this.lastUpdate = null;
    this.latestReleaseByEnvironment = {};

    this.cacheReleaseList = this.cacheReleaseList.bind(this);
    this.refreshCache = this.refreshCache.bind(this);
    this.loadCache = this.loadCache.bind(this);
    this.isOutdated = this.isOutdated.bind(this);
  }

  async cacheReleaseList(url) {
    const { token } = this.config;
    const headers = { Accept: "application/vnd.github.preview" };

    if (token && typeof token === "string" && token.length > 0) {
      headers.Authorization = `token ${token}`;
    }

    const { status, body } = await retry(
      async () => {
        const response = await fetch(url, { headers });

        if (response.status !== 200) {
          throw new Error(`Tried to cache RELEASES, but failed fetching ${url}, status ${status}`);
        }

        return response;
      },
      { retries: 3 },
    );

    let content = await convertStream(body);
    const matches = content.match(/[^ ]*\.nupkg/gim);

    if (matches.length === 0) {
      throw new Error(
        `Tried to cache RELEASES, but failed. RELEASES content doesn't contain nupkg`,
      );
    }

    for (let i = 0; i < matches.length; i += 1) {
      const nuPKG = url.replace("RELEASES", matches[i]);
      content = content.replace(matches[i], nuPKG);
    }
    return content;
  }

  async refreshCache() {
    const { account, repository, pre, token } = this.config;
    const repo = account + "/" + repository;
    const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
    const headers = { Accept: "application/vnd.github.preview" };

    if (token && typeof token === "string" && token.length > 0) {
      headers.Authorization = `token ${token}`;
    }

    const response = await retry(
      async () => {
        const response = await fetch(url, { headers });

        if (response.status !== 200) {
          throw new Error(`GitHub API responded with ${response.status} for url ${url}`);
        }

        return response;
      },
      { retries: 3 },
    );

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
      return;
    }

    const latestReleaseByEnvironment = {};
    data
      .filter((release) => !release.draft)
      .forEach((release) => {
        const tagName = release.tag_name;
        if (!tagName || !release.assets) {
          return;
        }

        const environmentName = tagName.split("-")[1] || "production";
        if (latestReleaseByEnvironment[environmentName]) {
          if (semver.gt(tagName, latestReleaseByEnvironment[environmentName].tag_name)) {
            latestReleaseByEnvironment[environmentName] = release;
          }
        } else {
          latestReleaseByEnvironment[environmentName] = release;
        }
      });

    this.latestReleaseByEnvironment = Object.fromEntries(
      Object.entries(latestReleaseByEnvironment)
        .map(([environmentName, release]) => {
          const platforms = Object.fromEntries(
            release.assets
              .map(({ name, browser_download_url, url, content_type, size }) => {
                const platform = checkPlatform(name);
                if (!platform) {
                  return null;
                }

                return [
                  platform,
                  {
                    name,
                    api_url: url,
                    url: browser_download_url,
                    content_type,
                    size: Math.round((size / 1000000) * 10) / 10,
                  },
                ];
              })
              .filter(Boolean),
          );

          if (Object.keys(platforms).length === 0) {
            return null;
          }

          return [
            environmentName,
            {
              version: release.tag_name,
              notes: release.body,
              pub_date: release.published_at,
              platforms,
            },
          ];
        })
        .filter(Boolean),
    );

    this.lastUpdate = Date.now();
  }

  isOutdated() {
    const { lastUpdate, config } = this;
    const { interval = 15 } = config;

    if (lastUpdate && Date.now() - lastUpdate > ms(`${interval}m`)) {
      return true;
    }

    return false;
  }

  // This is a method returning the cache
  // because the cache would otherwise be loaded
  // only once when the index file is parsed
  async loadCache() {
    const { latest, refreshCache, isOutdated, lastUpdate } = this;

    if (!lastUpdate || isOutdated()) {
      await refreshCache();
    }

    return {
      latest: { ...latest },
      latestReleaseByEnvironment: { ...this.latestReleaseByEnvironment },
    };
  }
};
