const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Registry,decodePhotos}=require('../registry');
function jpeg(fill=0){return Buffer.concat([Buffer.from([255,216]),Buffer.alloc(2100,fill),Buffer.from([255,217])]);}
const data=b=>'data:image/jpeg;base64,'+b.toString('base64');
test('registration accepts three JPEG views and legacy front-only submissions',()=>{
 const photos=decodePhotos({photos:{front:data(jpeg()),left:data(jpeg(1)),right:data(jpeg(2))}});
 assert.deepEqual(Object.keys(photos),['front','left','right']);
 assert.deepEqual(decodePhotos({photo:data(jpeg())}),{front:jpeg()});
 assert.throws(()=>decodePhotos({photos:{left:data(jpeg())}}),/front photo/);
 assert.throws(()=>decodePhotos({photos:{front:data(jpeg()),right:'not an image'}}),/JPEG/);
 assert.throws(()=>decodePhotos({photo:data(Buffer.alloc(2200))}),/invalid/);
});
test('all submitted photo views persist, reload and copy into the session',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mother-registry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'consent.example.md'),'Test registration fixture');
 const registry=new Registry(root),photos={front:jpeg(),left:jpeg(1),right:jpeg(2)};
 const person=registry.add({name:'Test Participant',email:'test@example.invalid',face:true,signature:'Test Participant',photos});
 const loaded=new Registry(root).get(person.pid);
 for(const angle of Object.keys(photos))assert.deepEqual(fs.readFileSync(path.join(root,loaded.photos[angle])),photos[angle]);
 const session=path.join(root,'session');fs.mkdirSync(session);
 const copied=registry.copyInto(session,person.pid,x=>x);
 assert.equal(copied.files.length,4);
 for(const name of ['photo.jpg','photo-left.jpg','photo-right.jpg'])assert.ok(copied.files.some(f=>f.name===name&&fs.existsSync(path.join(session,f.file))));
 assert.equal(copied.photo.endsWith('photo.jpg'),true);
});
