// Native
const urlHelpers = require("url");

// Packages
const { send } = require("micro");
const { valid, compare } = require("semver");
const { parse } = require("express-useragent");
const fetch = require("node-fetch");
const distanceInWordsToNow = require("date-fns/distance_in_words_to_now");

// Utilities
const checkAlias = require("./aliases");
const prepareView = require("./view");

module.exports = ({ cache, config }) => {
  const { loadCache } = cache;
  const exports = {};
  const { token, url } = config;
  const shouldProxyPrivateDownload = token && typeof token === "string" && token.length > 0;

  // Helpers
  const proxyPrivateDownload = (asset, req, res) => {
    const options = {
      headers: { Accept: "application/octet-stream" },
      redirect: "manual",
    };
    const { api_url: rawUrl } = asset;
    const finalUrl = rawUrl.replace("https://api.github.com/", `https://${token}@api.github.com/`);

    fetch(finalUrl, options).then((assetRes) => {
      res.setHeader("Location", assetRes.headers.get("Location"));
      send(res, 302);
    });
  };

  exports.download = async (req, res) => {
    const userAgent = parse(req.headers["user-agent"]);
    const params = urlHelpers.parse(req.url, true).query;
    const isUpdate = params && params.update;
    const environmentName = params && params.environmentName;
    if (!environmentName) {
      send(res, 404, "No download available for your platform!");
      return;
    }

    let platform;

    if (userAgent.isMac && isUpdate) {
      platform = "darwin";
    } else if (userAgent.isMac && !isUpdate) {
      platform = "dmg";
    } else if (userAgent.isWindows) {
      platform = "exe";
    }

    const { latestReleaseByEnvironment } = await loadCache();

    const latestEnvironmentRelease = latestReleaseByEnvironment[environmentName];
    if (!latestEnvironmentRelease || !platform || !latestEnvironmentRelease.platforms[platform]) {
      send(res, 404, "No download available for your platform!");
      return;
    }

    if (shouldProxyPrivateDownload) {
      proxyPrivateDownload(latestEnvironmentRelease.platforms[platform], req, res);
      return;
    }

    res.writeHead(302, {
      Location: latestEnvironmentRelease.platforms[platform].url,
    });

    res.end();
  };

  exports.downloadPlatform = async (req, res) => {
    const params = urlHelpers.parse(req.url, true).query;
    const isUpdate = params && params.update;
    const environmentName = params && params.environment;
    if (!environmentName) {
      send(res, 404, "No download available for your platform!");
      return;
    }

    let { platform } = req.params;

    if (platform === "mac" && !isUpdate) {
      platform = "dmg";
    }

    if (platform === "mac_arm64" && !isUpdate) {
      platform = "dmg_arm64";
    }

    // Get the latest version from the cache
    const { latestReleaseByEnvironment } = await loadCache();

    // Check platform for appropiate aliases
    platform = checkAlias(platform);

    if (!platform) {
      send(res, 500, "The specified platform is not valid");
      return;
    }

    const latestEnvironmentRelease = latestReleaseByEnvironment[environmentName];

    if (
      !latestEnvironmentRelease ||
      !latestEnvironmentRelease.platforms ||
      !latestEnvironmentRelease.platforms[platform]
    ) {
      send(res, 404, "No download available for your platform");
      return;
    }

    if (token && typeof token === "string" && token.length > 0) {
      proxyPrivateDownload(latestEnvironmentRelease.platforms[platform], req, res);
      return;
    }

    res.writeHead(302, {
      Location: latestEnvironmentRelease.platforms[platform].url,
    });

    res.end();
  };

  exports.update = async (req, res) => {
    const { platform: platformName, version } = req.params;
    const environmentName = version.split("-")[1] || "production";

    if (!valid(version)) {
      send(res, 500, {
        error: "version_invalid",
        message: "The specified version is not SemVer-compatible",
      });

      return;
    }

    const platform = checkAlias(platformName);

    if (!platform) {
      send(res, 500, {
        error: "invalid_platform",
        message: "The specified platform is not valid",
      });

      return;
    }

    const { latestReleaseByEnvironment } = await loadCache();

    const latestEnvironmentRelease = latestReleaseByEnvironment[environmentName];
    if (!latestEnvironmentRelease || !latestEnvironmentRelease.platforms[platform]) {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (compare(latestEnvironmentRelease.version, version) === 1) {
      const { notes, pub_date } = latestEnvironmentRelease;

      send(res, 200, {
        name: latestEnvironmentRelease.version,
        notes,
        pub_date,
        url: shouldProxyPrivateDownload
          ? `${url}/download/${platformName}?update=true&environment=${environmentName}`
          : latestEnvironmentRelease.platforms[platform].url,
      });
      return;
    }

    res.statusCode = 204;
    res.end();
  };

  // exports.releases = async (req, res) => {
  //   // Get the latest version from the cache
  //   const latest = await loadCache();

  //   if (!latest.files || !latest.files.RELEASES) {
  //     res.statusCode = 204;
  //     res.end();

  //     return;
  //   }

  //   const content = latest.files.RELEASES;

  //   res.writeHead(200, {
  //     "content-length": Buffer.byteLength(content, "utf8"),
  //     "content-type": "application/octet-stream",
  //   });

  //   res.end(content);
  // };

  exports.overview = async (req, res) => {
    const { latestReleaseByEnvironment } = await loadCache();

    send(res, 200, {
      latestReleaseByEnvironment,
    });
  };

  return exports;
};
