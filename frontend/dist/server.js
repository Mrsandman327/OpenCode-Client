const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

// 检查是否为目录
function isDirectory(pathname) {
  try {
    return fs.statSync(pathname).isDirectory();
  } catch (err) {
    return false;
  }
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url);
  let pathname = path.join(__dirname, parsedUrl.pathname);
  
  console.log(`请求: ${req.url} -> ${pathname}`);
  
  // 处理根路径
  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '') {
    pathname = path.join(__dirname, 'index.html');
  }
  
  // 检查路径是否存在
  fs.exists(pathname, (exist) => {
    if (!exist) {
      console.log(`文件不存在: ${pathname}`);
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<h1>404 Not Found</h1><p>找不到文件: ${req.url}</p>`);
      return;
    }
    
    // 如果是目录，返回 index.html（用于 SPA）
    if (isDirectory(pathname)) {
      const indexFile = path.join(pathname, 'index.html');
      fs.exists(indexFile, (indexExists) => {
        if (indexExists) {
          serveFile(indexFile, res);
        } else {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(`<h1>403 Forbidden</h1><p>目录浏览被禁止</p>`);
        }
      });
      return;
    }
    
    // 是文件，直接提供
    serveFile(pathname, res);
  });
});

function serveFile(pathname, res) {
  fs.readFile(pathname, (err, data) => {
    if (err) {
      console.error(`读取文件错误 ${pathname}:`, err);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<h1>500 Internal Server Error</h1><p>Error loading ${pathname}: ${err.message}</p>`);
    } else {
      const ext = path.parse(pathname).ext.toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache');
      res.end(data);
    }
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 服务器已启动`);
  console.log(`📁 本地访问: http://localhost:${PORT}`);
  console.log(`🌐 网络访问: http://${getLocalIP()}:${PORT}`);
  console.log('----------------------------------------');
  console.log(`工作目录: ${__dirname}`);
});

// 获取本机 IP 地址
function getLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return 'localhost';
}

// 处理 Ctrl+C 退出
process.on('SIGINT', () => {
  console.log('\n👋 服务器已停止');
  process.exit(0);
});