const fs=require('fs'),p=process.argv[2],n=JSON.parse(fs.readFileSync(p));
for(const s of n.stations) s.n=s.n.replace(/\s+(Platforms?|Track)\s+[\w&, ]+$/i,'').replace(/\s*\((north|south|east|west)bound\)$/i,'');
for(const l of n.lines) if(/^DLR\b/.test(l.name)) l.ref='DLR';
fs.writeFileSync(p,JSON.stringify(n)); console.log(p,n.stations.length,n.lines.length);
