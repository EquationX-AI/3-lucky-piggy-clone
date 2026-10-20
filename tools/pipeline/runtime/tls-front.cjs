// 极简 HTTPS 前门：把 https://127.0.0.1:5643/* 原样转发到 http://127.0.0.1:5630/*
const https=require('https'), http=require('http'), net=require('net'), fs=require('fs');
const opts={key:fs.readFileSync(process.env.KEY),cert:fs.readFileSync(process.env.CERT)};
const BACK=Number(process.env.BACK||5630);
const server=https.createServer(opts,(req,res)=>{
  const p=http.request({host:'127.0.0.1',port:BACK,path:req.url,method:req.method,headers:Object.assign({},req.headers,{host:'127.0.0.1:'+BACK})},up=>{
    const h=Object.assign({},up.headers,{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','cross-origin-resource-policy':'cross-origin'});
    res.writeHead(up.statusCode,h); up.pipe(res);
  });
  p.on('error',e=>{res.writeHead(502);res.end('proxy error '+e.message)});
  req.pipe(p);
});
// WebSocket upgrade 原样透传到后端（否则 upgrade 会落到普通请求分支，回 200 导致握手失败）
server.on('upgrade',(req,socket,head)=>{
  const s=net.connect(BACK,'127.0.0.1',()=>{
    s.write(req.method+' '+req.url+' HTTP/1.1\r\n');
    for(let i=0;i<req.rawHeaders.length;i+=2) s.write(req.rawHeaders[i]+': '+req.rawHeaders[i+1]+'\r\n');
    s.write('\r\n');
    if(head&&head.length) s.write(head);
    socket.pipe(s); s.pipe(socket);
  });
  s.on('error',()=>socket.destroy());
  socket.on('error',()=>s.destroy());
});
server.listen(Number(process.env.LPORT||5643),'127.0.0.1',()=>console.log('READY'));
