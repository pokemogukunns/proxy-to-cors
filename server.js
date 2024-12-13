const http = require('http');
const config = require('./config');
const request = require('request');
const url = require('url');
const throttle = require('tokenthrottle')({ rate: config.max_requests_per_second });
const publicAddressFinder = require('public-address');

http.globalAgent.maxSockets = Infinity;

let publicIP;

publicAddressFinder(function (err, data) {
    if (!err && data) {
        publicIP = data.address;
    }
});

function addCORSHeaders(req, res) {
    if (req.method.toUpperCase() === 'OPTIONS') {
        if (req.headers['access-control-request-headers']) {
            res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers']);
        }

        if (req.headers['access-control-request-method']) {
            res.setHeader('Access-Control-Allow-Methods', req.headers['access-control-request-method']);
        }
    }

    if (req.headers['origin']) {
        res.setHeader('Access-Control-Allow-Origin', req.headers['origin']);
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
}

function writeResponse(res, httpCode, body) {
    res.statusCode = httpCode;
    res.end(body);
}

function sendInvalidURLResponse(res) {
    return writeResponse(res, 404, 'url must be in the form of /fetch/{some_url_here}');
}

function sendTooBigResponse(res) {
    return writeResponse(res, 413, 'the content in the request or response cannot exceed ' + config.max_request_length + ' characters.');
}

function getClientAddress(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0] || req.connection.remoteAddress;
}

function processRequest(req, res) {
    addCORSHeaders(req, res);

    if (req.method.toUpperCase() === 'OPTIONS') {
        return writeResponse(res, 204);
    }

    const result = config.fetch_regex.exec(req.url);

    if (result && result.length === 2 && result[1]) {
        let remoteURL;

        try {
            remoteURL = url.parse(decodeURI(result[1]));
        } catch (e) {
            return sendInvalidURLResponse(res);
        }

        if (!remoteURL.host) {
            return writeResponse(res, 404, 'relative URLS are not supported');
        }

        if (config.blacklist_hostname_regex.test(remoteURL.hostname)) {
            return writeResponse(res, 400, 'naughty, naughty...');
        }

        if (remoteURL.protocol !== 'http:' && remoteURL.protocol !== 'https:') {
            return writeResponse(res, 400, 'only http and https are supported');
        }

        if (publicIP) {
            if (req.headers['x-forwarded-for']) {
                req.headers['x-forwarded-for'] += ', ' + publicIP;
            } else {
                req.headers['x-forwarded-for'] = req.clientIP + ', ' + publicIP;
            }
        }

        if (req.headers['host']) {
            req.headers['host'] = remoteURL.host;
        }

        delete req.headers['origin'];
        delete req.headers['referer'];

        const proxyRequest = request({
            url: remoteURL,
            headers: req.headers,
            method: req.method,
            timeout: config.proxy_request_timeout_ms,
            strictSSL: false
        });

        proxyRequest.on('error', function (err) {
            if (err.code === 'ENOTFOUND') {
                return writeResponse(res, 502, 'Host for ' + url.format(remoteURL) + ' cannot be found.');
            } else {
                console.log('Proxy Request Error (' + url.format(remoteURL) + '): ' + err.toString());
                return writeResponse(res, 500);
            }
        });

        let requestSize = 0;
        let proxyResponseSize = 0;

        req.pipe(proxyRequest).on('data', function (data) {
            requestSize += data.length;
            if (requestSize >= config.max_request_length) {
                proxyRequest.end();
                return sendTooBigResponse(res);
            }
        }).on('error', function (err) {
            writeResponse(res, 500, 'Stream Error');
        });

        proxyRequest.pipe(res).on('data', function (data) {
            proxyResponseSize += data.length;
            if (proxyResponseSize >= config.max_request_length) {
                proxyRequest.end();
                return sendTooBigResponse(res);
            }
        }).on('error', function (err) {
            writeResponse(res, 500, 'Stream Error');
        });
    } else {
        return sendInvalidURLResponse(res);
    }
}

const requestListener = function (req, res) {
    const clientIP = getClientAddress(req);
    req.clientIP = clientIP;

    if (config.enable_logging) {
        console.log('%s %s %s', (new Date()).toJSON(), clientIP, req.method, req.url);
    }

    if (config.enable_rate_limiting) {
        throttle.rateLimit(clientIP, function (err, limited) {
            if (limited) {
                return writeResponse(res, 429, 'enhance your calm');
            }
            processRequest(req, res);
        });
    } else {
        processRequest(req, res);
    }
};

const server = http.createServer(requestListener);

module.exports = server;
