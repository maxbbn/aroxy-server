var connect = require('connect')
  , http = require('http')
  , url = require('url')
  , _ = require('underscore')
  , comboParser = require('combo-url-parser');

var settingStore = {
  '0.0.0.0': {
    'rhost': '',
    'port': '',
    'dirs': ['/p/detail', '/apps/ratemanager'],
    'pre': false
  }
};


//get dirs from string
function getDirs(src) {
  return src
    .split(',')
    .map(function (item) {
      return item.trim();
    })
    .filter(function (item){
      return item;
    })
    .map(function (item) {
      return item.replace(/\/?$/, '/');
    });
}

var app = connect()
  .use(connect.favicon())
  .use(connect.logger('short'))
  .use(function (req, res, next) {
    var ua = req.headers['user-agent'];

    if (ua.indexOf('aRoxy') > -1) {
      res.end('/** Request From aRoxy **/');
      return;
    }

    next();
  })

  // .use(connect.cookieParser())

  .use(connect.query())
  
  .use(function (req, res, next) {
    req.address = req.headers['x-real-ip'] || req.connection.address().address;
    next();
  })



  //Setting
  /**
   * Setting
   *  - debug: will translate -min.js to .js && -min.css to .css for matched files
   *  - host: will ignore the request host and request unmatched files from the given host
   *  - redirectHost: 
   *  - redirectPort: default value is 3722
   *  - dirs: is the path schema for matched files
   *  - pre:  set pre pub env 
   */
  .use(function (req, res, next) {
    var address = req.address;

    var setting = settingStore[address] || {
      rhost: address,
      rport: 3722,
      pre: false,
      debug: false
    };

    var oUrl = url.parse(req.url);

    if (oUrl.pathname === '/setting') {
      var query = req.query;
      var newSetting = _.pick(query, 'rport', 'rhost', 'debug', 'pre', 'dirs', 'host');
      if ( _.keys(newSetting).length ) {
        _.each(newSetting, function (v, k) {
          v = v.trim();
          switch(k) {
            case 'rport':
              v = v || 3722;
              break;
            case 'rhost':
              v = v || address;
              break;
            case 'debug':
            case 'pre':
              v = !!v;
              break;
            case 'dirs':
              v = getDirs(v);
              break;
          }
          newSetting[k] = v;
        });

        setting = _.defaults(newSetting, setting);
        settingStore[address] = setting;
        
      }
      res.end(JSON.stringify(setting, null, 4));
      return;
    }

    req.setting = setting;
    next();
  })


  //parser combo
  .use(function(req, res, next) {
    if (!req.requestPath) {
      var p =  url.parse(req.url);
      req.requestPath = comboParser(p.path);
      next();
    }
  })


  //resolvedPath
  .use(function (req, res, next) {
    var setting = req.setting;
    var address = req.address;
    var debug = setting.debug;

    var dirs;

    if (setting.dirs) {
      dirs = setting.dirs;
    }

    var rport = setting.rport;
    var rhost = setting.rhost;

    var host = setting.host || req.headers.host;

    if ((host === 'a.tbcdn.cn' || host === 'l.tbcdn.cn') && setting.pre) {
      host = '110.75.14.33';
    }

    var resolvedPath = req.requestPath.map(function (p) {
      // 匹配判断
      if (dirs && dirs.length) {
        for (var i = 0, l = dirs.length; i < l; i++) {

          if (p === dirs[i] || p.indexOf(dirs[i]) === 0) {

            if (debug) {
                p = p.replace(/(-min)\.(js|css)$/g, '.$2');
            }

            return {
              protocol: 'http',
              pathname: p,
              host: rhost + ':' + rport
            };
          }
        }
      }

      return {
        protocol: 'http',
        pathname: p,
        host: host
      };
    });
    req.resolvedPath = resolvedPath;
    next();
  })

  // .use(function (req, res, next) {
  //   req.resolvedPath.forEach(function (line) {
  //     console.log(line);
  //   })
  //   console.log('\n');
  //   next();
  // })

  //do proxy
  .use(function(req, res){
    var resolvedPath = req.resolvedPath;
    var index = 0;
    var len = resolvedPath.length;

    resolvedPath.forEach(function (option) {
      option.resurl = url.format(option);
    });

    res.setHeader('Server', 'aRoxy');

    function readNextFile() {
      var isFirstRequest = index === 0;
      if(index >= len) {
        return res.end();
      } else if (!isFirstRequest) {
        res.write('\n');
      }
      var option = resolvedPath[index];
      index += 1;

      // option.headers = {
      //   'user-agent': req.headers['user-agent'] + ' aRoxy'
      // };
      var reqOption = _.pick(option, 'host', 'pathname');

      function onRequest (cRes) {

        if (isFirstRequest) {
          //setHeader
          var reqHeader = cRes.headers;
          if (reqHeader['content-type']) {
            res.setHeader('Content-Type', reqHeader['content-type']);
          }

          //set filelist
          if (len > 1) {
            res.write('/**\n * aRoxy \n');

            resolvedPath.forEach(function (line) {
              res.write(' * '+ line.resurl + '\n');
            });

            res.write(' **/\n');
          }
        }
        
        if (cRes.statusCode !== 200) {
          res.write('\n /** [ERROR: ' + cRes.statusCode +'] ' + option.resurl + '**/');
          return readNextFile();
        }

        cRes.pipe(res,  { end: false });
        cRes.on('end', function () {
          readNextFile();
        });
      }

      var assetsReq = http.get(option.resurl, onRequest);

      assetsReq
        .setTimeout(30000, function () {
          res.write('\n /** [TIMEOUT] ' + option.resurl + '**/');
          assetsReq.abort();
          readNextFile();
        });

      assetsReq
        .on('error', function (err) {
          res.write('\n /** [ERROR] Cant\'t get '  + option.resurl + ' **/' );
          readNextFile();
        })
    };

    readNextFile();
    
  });

http.createServer(app).listen(3721);

console.log('server starting %s:%s', '0.0.0.0', '3721');