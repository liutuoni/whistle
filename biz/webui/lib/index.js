var express = require('express');
var app = express();
var path = require('path');
var url = require('url');
var getAuth = require('basic-auth');
var parseurl = require('parseurl');
var bodyParser = require('body-parser');
var crypto = require('crypto');
var cookie = require('cookie');
var fs = require('fs');
var zlib = require('zlib');
var htdocs = require('../htdocs');
var handleWeinreReq = require('../../weinre');
var setProxy = require('./proxy');
var getRootCAFile = require('../../../lib/https/ca').getRootCAFile;
var config = require('../../../lib/config');
var loadAuthPlugins = require('../../../lib/plugins').loadAuthPlugins;

var PARSE_CONF = { extended: true, limit: '3mb'};
var UPLOAD_PARSE_CONF = { extended: true, limit: '30mb'};
var urlencodedParser = bodyParser.urlencoded(PARSE_CONF);
var jsonParser = bodyParser.json(PARSE_CONF);
var uploadUrlencodedParser = bodyParser.urlencoded(UPLOAD_PARSE_CONF);
var uploadJsonParser = bodyParser.json(UPLOAD_PARSE_CONF);
var GET_METHOD_RE = /^get$/i;
var WEINRE_RE = /^\/weinre\/.*/;
var ALLOW_PLUGIN_PATHS = ['/cgi-bin/rules/list2', '/cgi-bin/values/list2', '/cgi-bin/get-custom-certs-info'];
var DONT_CHECK_PATHS = ['/cgi-bin/server-info', '/cgi-bin/plugins/is-enable', '/cgi-bin/plugins/get-plugins',
  '/preview.html', '/cgi-bin/rootca', '/cgi-bin/log/set', '/cgi-bin/status'];
var GUEST_PATHS = ['/cgi-bin/composer', '/cgi-bin/socket/data', '/cgi-bin/abort', '/cgi-bin/socket/abort',
  '/cgi-bin/socket/change-status', '/cgi-bin/sessions/export'];
var PLUGIN_PATH_RE = /^\/(whistle|plugin)\.([^/?#]+)(\/)?/;
var STATIC_SRC_RE = /\.(?:ico|js|css|png)$/i;
var UPLOAD_URLS = ['/cgi-bin/values/upload', '/cgi-bin/composer'];
var proxyEvent, util, pluginMgr;
var MAX_AGE = 60 * 60 * 24 * 3;
var MENU_HTML = fs.readFileSync(path.join(__dirname, '../../../assets/menu.html'));
var MENU_URL = '???_WHISTLE_PLUGIN_EXT_CONTEXT_MENU_' + config.port + '???';
var UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

function doNotCheckLogin(req) {
  var path = req.path;
  return STATIC_SRC_RE.test(path) || DONT_CHECK_PATHS.indexOf(path) !== -1;
}

function getUsername() {
  return config.username || '';
}

function getPassword() {
  return config.password || '';
}

function shasum(str) {
  var shasum = crypto.createHash('sha1');
  shasum.update(str || '');
  return shasum.digest('hex');
}

function getLoginKey (req, res, auth) {
  var ip = util.getClientIp(req);
  var password = auth.password;
  if (config.encrypted) {
    password = shasum(password);
  }
  return shasum([auth.username, password, ip].join('\n'));
}

function requireLogin(res) {
  res.setHeader('WWW-Authenticate', ' Basic realm=User Login');
  res.setHeader('Content-Type', 'text/html; charset=utf8');
  res.status(401).end('Access denied, please <a href="javascript:;" onclick="location.reload()">try again</a>.');
}

function verifyLogin(req, res, auth) {
  var isGuest = !auth;
  if (isGuest) {
    auth = config.guest;
    if (!auth) {
      return;
    }
    if (!auth.authKey) {
      auth.authKey = 'whistle_v_lk_' + encodeURIComponent(auth.username);
    }
  }
  var username = auth.username;
  var password = auth.password;

  if (!username && !password) {
    return true;
  }
  var authKey = auth.authKey;
  var cookies = cookie.parse(req.headers.cookie || '');
  var lkey = cookies[authKey];
  var correctKey = getLoginKey(req, res, auth);
  if (correctKey === lkey) {
    return true;
  }
  auth = getAuth(req) || {};
  if (!isGuest && config.encrypted) {
    auth.pass = shasum(auth.pass);
  }
  if (auth.name === username && auth.pass === password) {
    var options = {
      expires: new Date(Date.now() + (MAX_AGE * 1000)),
      maxAge: MAX_AGE,
      path: '/'
    };
    res.setHeader('Set-Cookie', cookie.serialize(authKey, correctKey, options));
    return true;
  }
}

function checkAuth(req, res, auth) {
  if (verifyLogin(req, res, auth)) {
    return true;
  }
  requireLogin(res);
  return false;
}

app.disable('x-powered-by');

app.use(function(req, res, next) {
  proxyEvent.emit('_request', req.url);
  var aborted;
  var abort = function() {
    if (!aborted) {
      aborted = true;
      res.destroy();
    }
  };
  req.on('error', abort);
  res.on('error', abort).on('close', abort);
  loadAuthPlugins(req, function(status, msg) {
    if (!status) {
      return next();
    }
    res.set('x-server', 'whistle');
    res.set('x-module', 'webui');
    if (!msg) {
      return res.redirect(status);
    }
    if (status === 401) {
      return requireLogin(res);
    }
    res.set('Content-Type', 'text/html; charset=utf8');
    if (status === 502) {
      return res.status(502).end(msg || 'Error');
    }
    res.status(403).end('Forbidden');
  });
});

if (typeof config.uiMiddleware === 'function') {
  app.use(config.uiMiddleware);
}

app.use(function(req, res, next) {
  var referer = req.headers.referer;
  var options = parseurl(req);
  var path = options.path;
  var index = path.indexOf('/whistle/');
  req.url = path;
  if (index === 0) {
    delete req.headers.referer;
    req.url = path.substring(8);
  } else if (PLUGIN_PATH_RE.test(options.pathname)) {
    var pluginName = RegExp['$&'];
    var len = pluginName.length - 1;
    if (len === index) {
      delete req.headers.referer;
      req.url = path.substring(len + 8);
    }
  } else {
    pluginName = config.getPluginNameByHost(req.headers.host);
    if (!pluginName && referer) {
      var refOpts = url.parse(referer);
      var pathname = refOpts.pathname;
      if (PLUGIN_PATH_RE.test(pathname) && RegExp.$3) {
        req.url = '/' + RegExp.$1 + '.' + RegExp.$2 + path;
      } else {
        pluginName = config.getPluginNameByHost(refOpts.hostname);
      }
    }
    if (pluginName) {
      req.url = '/whistle.' + pluginName + path;
    }
  }

  next();
});

app.use(function(req, res, next) {
  if (req.headers.host !== 'rootca.pro') {
    return next();
  }
  res.download(getRootCAFile(), 'rootCA.' + (req.path.indexOf('/cer') ? 'crt' : 'cer'));
});

function cgiHandler(req, res) {
  if (UP_PATH_REGEXP.test(req.path)) {
    return res.status(403).end('Forbidden');
  }
  if (req.headers.origin) {
    res.setHeader('access-control-allow-origin', req.headers.origin);
    res.setHeader('access-control-allow-credentials', true);
  }
  var filepath = path.join(__dirname, '..' + req.path) + '.js';
  var handleResponse = function() {
    try {
      require(filepath)(req, res);
    } catch(err) {
      var msg = config.debugMode ? '<pre>' + util.getErrorStack(err) + '</pre>' : 'Internal Server Error';
      res.status(500).send(msg);
    }
  };
  if (require.cache[filepath]) {
    return handleResponse();
  }
  fs.stat(filepath, function(err, stat) {
    if (err || !stat.isFile()) {
      var notFound = err ? err.code === 'ENOENT' : !stat.isFile();
      var msg;
      if (config.debugMode) {
        msg =  '<pre>' + (err ? util.getErrorStack(err) : 'Not File') + '</pre>';
      } else {
        msg = notFound ? 'Not Found' : 'Internal Server Error';
      }
      return res.status(notFound ? 404 : 500).send(msg);
    }
    handleResponse();
  });
}

app.all('/cgi-bin/sessions/*', cgiHandler);
app.all('/favicon.ico', function(req, res) {
  res.sendFile(htdocs.getImgFile('favicon.ico'));
});
app.all(PLUGIN_PATH_RE, function(req, res) {
  var result = PLUGIN_PATH_RE.exec(req.url);
  var type = result[1];
  var name = result[2];
  var slash = result[3];
  var plugin = type === 'whistle' ? pluginMgr.getPlugin(name + ':')
    : pluginMgr.getPluginByName(name);
  if (!plugin) {
    return res.status(404).send('Not Found');
  }
  if (req.url.indexOf(MENU_URL) !== -1) {
    res.type('html');
    res.write(plugin[util.PLUGIN_MENU_CONFIG]);
    res.write(MENU_HTML);
    var index = req.path.indexOf('/', 1);
    if (index === -1) {
      res.end();
    } else {
      var filepath = req.path.substring(index + 1);
      var reader = fs.createReadStream(path.join(plugin.path, filepath));
      reader.on('error', function() {
        if (reader) {
          reader = null;
          res.end();
        }
      });
      reader.pipe(res);
    }
    return;
  }
  if (!slash) {
    return res.redirect(type + '.' + name + '/');
  }
  pluginMgr.loadPlugin(plugin, function(err, ports) {
    if (err || !ports.uiPort) {
      if (err) {
        res.status(500).send('<pre>' + err + '</pre>');
      } else {
        res.status(404).send('Not Found');
      }
      return;
    }
    var options = parseurl(req);
    req.headers[config.PLUGIN_HOOK_NAME_HEADER] = config.PLUGIN_HOOKS.UI;
    req.url = options.path.replace(result[0].slice(0, -1), '');
    util.transformReq(req, res, ports.uiPort);
  });
});

app.use(function(req, res, next) {
  if (ALLOW_PLUGIN_PATHS.indexOf(req.path) !== -1) {
    var name = req.headers[config.PROXY_ID_HEADER];
    if (name) {
      return pluginMgr.getPlugin(name + ':') ? next() : res.sendStatus(403);
    }
  }
  if (doNotCheckLogin(req)) {
    return next();
  }
  if (config.disableWebUI && !config.debugMode) {
    return res.status(404).end('Not Found');
  }
  if (config.authKey && config.authKey === req.headers['x-whistle-auth-key']) {
    return next();
  }
  var guestAuthKey = config.guestAuthKey;
  if (((guestAuthKey && guestAuthKey === req.headers['x-whistle-guest-auth-key'])
    || verifyLogin(req, res)) && (!req.method || GET_METHOD_RE.test(req.method)
    || WEINRE_RE.test(req.path) || GUEST_PATHS.indexOf(req.path) !== -1)) {
    return next();
  }
  var username = getUsername();
  var password = getPassword();
  var authConf = {
    authKey: 'whistle_lk_' + encodeURIComponent(username),
    username: username,
    password: password
  };
  if (checkAuth(req, res, authConf)) {
    next();
  }
});

app.all('/cgi-bin/*', function(req, res, next) {
  req.isUploadReq = UPLOAD_URLS.indexOf(req.path) !== -1;
  return req.isUploadReq ? uploadUrlencodedParser(req, res, next) : urlencodedParser(req, res, next);
}, function(req, res, next) {
  return req.isUploadReq ? uploadJsonParser(req, res, next) : jsonParser(req, res, next);
}, cgiHandler);

app.use('/preview.html', function(req, res, next) {
  if (req.headers[config.INTERNAL_ID_HEADER] !== config.INTERNAL_ID) {
    return res.status(404).end('Not Found');
  }
  next();
  var index = req.path.indexOf('=') + 1;
  if (index) {
    var charset = req.path.substring(index);
    res.set('content-type', 'text/html;charset=' + charset);
  }
});
if (!config.debugMode) {
  var indexHtml = fs.readFileSync(htdocs.getHtmlFile('index.html'));
  var indexJs = fs.readFileSync(htdocs.getJsFile('index.js'));
  var jsETag = shasum(indexJs);
  var gzipIndexJs = zlib.gzipSync(indexJs);
  app.use('/js/index.js', function(req, res) {
    if (req.headers['if-none-match'] === jsETag) {
      return res.sendStatus(304);
    }
    var headers = {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      ETag: jsETag
    };
    if (util.canGzip(req)) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.end(gzipIndexJs);
    } else {
      res.writeHead(200, headers);
      res.end(indexJs);
    }
  });
  var sendIndex = function(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8'
    });
    res.end(indexHtml);
  };
  app.get('/', sendIndex);
  app.get('/index.html', sendIndex);
}

app.get('/', function(req, res) {
  res.sendFile(htdocs.getHtmlFile('index.html'));
});

app.all(WEINRE_RE, function(req, res) {
  var options = parseurl(req);
  if (options.pathname === '/weinre/client') {
    return res.redirect('client/' + (options.search || ''));
  }
  req.url = options.path.replace('/weinre', '');
  handleWeinreReq(req, res);
});

function init(proxy) {
  if (proxyEvent) {
    return;
  }
  proxyEvent = proxy;
  pluginMgr = proxy.pluginMgr;
  util = proxy.util;
  setProxy(proxy);
}

app.use(express.static(path.join(__dirname, '../htdocs'), {maxAge: 300000}));

exports.init = init;
exports.setupServer = function(server) {
  server.on('request', app);
};
module.exports.handleRequest = app;
