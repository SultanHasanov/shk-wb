const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const crypto = require('crypto');
const { qrPng, qrTextPng, returnStickerDesign, stickerDecorations, splitCode } = require('../../server/_stickers');
const { supabaseFetch } = require('../../server/_supabase');
const { requireUser } = require('../../server/_user-auth');

const mm = (value) => value * 72 / 25.4;
const A4_WIDTH = mm(210);
const A4_HEIGHT = mm(297);
const MARGIN = mm(8);
const GAP = mm(2);
const DEFAULT_COLUMNS = 4;
const MAX_COLUMNS = 5;

/**
 * Раскладка листа под заданное число стикеров в ряд. Раньше сетка 4×3 была
 * зашита константами, из-за чего печать на термопринтере (один стикер в ряд)
 * была невозможна. При columns=4 расчёт даёт ровно прежние 4×3, поэтому
 * привычный лист не меняется.
 */
function layoutFor(columns) {
  const available = A4_HEIGHT - 2 * MARGIN;
  const cellWidth = (A4_WIDTH - 2 * MARGIN - GAP * (columns - 1)) / columns;
  // Стикер сохраняет пропорции 600×900. На одной колонке он по ширине упёрся бы
  // в высоту листа, поэтому дополнительно ограничиваем его доступной высотой.
  const stickerWidth = Math.min(cellWidth, available / 1.5);
  const stickerHeight = stickerWidth * 1.5;
  const rows = Math.max(1, Math.floor((available + GAP) / (stickerHeight + GAP)));
  const cellHeight = (available - GAP * (rows - 1)) / rows;
  return { columns, rows, perPage: columns * rows, cellWidth, cellHeight, stickerWidth, stickerHeight };
}

// Размеры шрифтов ниже подобраны под стикер прежней сетки 4×3. Позиции текста
// масштабируются вместе со стикером, поэтому и кегль должен: иначе на одной
// колонке крупный стикер получал прежние мелкие цифры, разъехавшиеся по полю.
const BASE_STICKER_WIDTH = layoutFor(DEFAULT_COLUMNS).stickerWidth;

function drawBoxSticker(page, font, codeFont, code, prefix, qr, slot, layout) {
  const { columns: COLUMNS, cellWidth: CELL_WIDTH, cellHeight: CELL_HEIGHT,
    stickerWidth: STICKER_WIDTH, stickerHeight: STICKER_HEIGHT } = layout;
  const column = slot % COLUMNS;
  const row = Math.floor(slot / COLUMNS);
  const originX = MARGIN + column * (CELL_WIDTH + GAP) + (CELL_WIDTH - STICKER_WIDTH) / 2;
  const cellBottom = A4_HEIGHT - MARGIN - (row + 1) * CELL_HEIGHT - row * GAP;
  const originY = cellBottom + (CELL_HEIGHT - STICKER_HEIGHT) / 2;
  const sx = STICKER_WIDTH / 600;
  const sy = STICKER_HEIGHT / 900;
  const design = returnStickerDesign(code);
  design.displayCode=prefix+code;

  page.drawRectangle({ x:originX, y:originY, width:STICKER_WIDTH, height:STICKER_HEIGHT,
    color:rgb(1,1,1), borderColor:rgb(.86,.86,.88), borderWidth:.4 });
  const fontScale = STICKER_WIDTH / BASE_STICKER_WIDTH;
  const centered = (text,y,size,selectedFont=font) => page.drawText(text,{x:originX+(STICKER_WIDTH-selectedFont.widthOfTextAtSize(text,size))/2,y:originY+y*sy,size,font:selectedFont,color:rgb(.07,.07,.07)});
  centered(design.title, 752, 18*fontScale, font);
  page.drawImage(qr, { x:originX+design.qr.x*sx, y:originY+STICKER_HEIGHT-(design.qr.y+design.qr.size)*sy,
    width:design.qr.size*sx, height:design.qr.size*sy });
  const maxWidth=STICKER_WIDTH-8*sx;
  let codeSize=11*fontScale;
  while(codeSize>7*fontScale&&codeFont.widthOfTextAtSize(design.displayCode,codeSize)>maxWidth)codeSize-=.5*fontScale;
  centered(design.displayCode, 75, codeSize, codeFont);
}

function drawProductSticker(page,font,code,qr,slot,layout){
  const {columns:COLUMNS,cellWidth:CELL_WIDTH,cellHeight:CELL_HEIGHT,stickerWidth:STICKER_WIDTH}=layout;
  const column=slot%COLUMNS,row=Math.floor(slot/COLUMNS),originX=MARGIN+column*(CELL_WIDTH+GAP)+(CELL_WIDTH-STICKER_WIDTH)/2,cellBottom=A4_HEIGHT-MARGIN-(row+1)*CELL_HEIGHT-row*GAP;
  const productHeight=STICKER_WIDTH*740/600,originY=cellBottom+(CELL_HEIGHT-productHeight)/2,sx=STICKER_WIDTH/600,sy=productHeight/740,design=stickerDecorations(code);
  const drawRects=(items,color)=>items.forEach(item=>page.drawRectangle({x:originX+item.x*sx,y:originY+productHeight-(item.y+item.height)*sy,width:item.width*sx,height:item.height*sy,color}));
  page.drawRectangle({x:originX,y:originY,width:STICKER_WIDTH,height:productHeight,color:rgb(1,1,1),borderColor:rgb(.86,.86,.88),borderWidth:.4});
  drawRects(design.left.bars,rgb(0,0,0));drawRects(design.right.bars,rgb(0,0,0));drawRects(design.left.cuts,rgb(1,1,1));drawRects(design.right.cuts,rgb(1,1,1));
  const fontScale=STICKER_WIDTH/BASE_STICKER_WIDTH;
  const wbSize=24*fontScale,wb='wb';page.drawText(wb,{x:originX+(STICKER_WIDTH-font.widthOfTextAtSize(wb,wbSize))/2,y:originY+productHeight-140*sy,size:wbSize,font,color:rgb(.898,0,.49)});
  design.corners.forEach(corner=>page.drawImage(qr,{x:originX+corner.x*sx,y:originY+productHeight-(corner.y+design.cornerSize)*sy,width:design.cornerSize*sx,height:design.cornerSize*sy}));
  page.drawRectangle({x:originX+118*sx,y:originY+productHeight-534*sy,width:364*sx,height:364*sy,color:rgb(1,1,1)});
  page.drawImage(qr,{x:originX+design.qr.x*sx,y:originY+productHeight-(design.qr.y+design.qr.size)*sy,width:design.qr.size*sx,height:design.qr.size*sy});
  const parts=splitCode(code),centered=(text,y,size)=>page.drawText(text,{x:originX+(STICKER_WIDTH-font.widthOfTextAtSize(text,size))/2,y:originY+y*sy,size,font,color:rgb(0,0,0)});
  if(parts[1]){centered(parts[0],123,11*fontScale);centered(parts[1],49,17*fontScale)}else centered(parts[0],69,16*fontScale);
}

module.exports = async function handler(req,res){
  if(req.method!=='GET')return res.status(405).end();
  const batch=String(req.query?.batch||''),historyId=String(req.query?.history||''),customCode=String(req.query?.code||'');
  const token=String(req.query?.token||''),expires=Number(req.query?.expires||0);
  if(!historyId&&!customCode&&!/^[0-9a-f-]{36}$/i.test(batch))return res.status(400).end();
  if(historyId&&!/^\d+$/.test(historyId))return res.status(400).end();
  let boxMode=String(req.query?.variant||'')==='box',prefix=String(req.query?.prefix||'TRBX').toUpperCase();
  const requestedColumns=Number(req.query?.columns||DEFAULT_COLUMNS);
  if(!Number.isInteger(requestedColumns)||requestedColumns<1||requestedColumns>MAX_COLUMNS)return res.status(400).end();
  const layout=layoutFor(requestedColumns);
  // Печатать можно часть пачки: из 200 стикеров человеку сейчас нужны 10.
  // Список приходит явными кодами, чтобы выбор не зависел от порядка на клиенте.
  const requestedCodes=String(req.query?.codes||'').split(',').map(value=>value.trim()).filter(Boolean);
  if(requestedCodes.length>500||requestedCodes.some(code=>!/^[0-9]{1,20}$/.test(code)))return res.status(400).end();
  const selected=requestedCodes.length?new Set(requestedCodes):null;
  try{
    let all;
    if(customCode){
      if(!/^\d{1,12}$/.test(customCode)||!process.env.STICKER_CLIENT_SECRET)return res.status(400).end();
      const now=Math.floor(Date.now()/1000);
      if(!Number.isInteger(expires)||expires<now||expires>now+3700)return res.status(403).end();
      const signedValue=`${boxMode?`${prefix}:${customCode}`:customCode}:${expires}`;
      const expected=crypto.createHmac('sha256',process.env.STICKER_CLIENT_SECRET).update(signedValue).digest('base64url');
      const left=Buffer.from(token),right=Buffer.from(expected);
      if(left.length!==right.length||!crypto.timingSafeEqual(left,right))return res.status(403).end();
      all=[{code:customCode}];
    }else if(historyId){
      const user=await requireUser(req,res);if(!user)return;
      const history=await supabaseFetch(`user_generation_history?id=eq.${encodeURIComponent(historyId)}&user_id=eq.${encodeURIComponent(user.id)}&select=payload&limit=1`);
      if(!history.length)return res.status(404).end();
      const payload=history[0].payload||{};
      boxMode=payload.category==='box';prefix=String(payload.prefix||'TRBX').toUpperCase();
      const historyCodes=Array.isArray(payload.codes)&&payload.codes.length?payload.codes:(payload.code?[payload.code]:[]);
      all=historyCodes.map(code=>({code:String(code)}));
    }else{
      const table=boxMode?'return_box_codes':'return_sticker_codes';
      all=await supabaseFetch(`${table}?batch_id=eq.${encodeURIComponent(batch)}&select=code&order=code.asc`);
    }
    if(boxMode&&!/^[A-Z0-9_-]{1,12}$/.test(prefix))return res.status(400).end();
    const rows=selected?all.filter(row=>selected.has(String(row.code))):all;
    if(!rows.length)return res.status(404).end(); if(rows.length>500)return res.status(413).end();
    const pdf=await PDFDocument.create();
    const font=await pdf.embedFont(StandardFonts.HelveticaBold);
    const codeFont=await pdf.embedFont(StandardFonts.CourierBold);
    let page;
    for(let pageStart=0;pageStart<rows.length;pageStart+=layout.perPage){
      page=pdf.addPage([A4_WIDTH,A4_HEIGHT]);
      const pageRows=rows.slice(pageStart,pageStart+layout.perPage);
      const qrBuffers=await Promise.all(pageRows.map((row)=>boxMode?qrTextPng(prefix+row.code,504,1):qrPng(row.code,504,1)));
      for(let slot=0;slot<pageRows.length;slot+=1){
        const qr=await pdf.embedPng(qrBuffers[slot]);
        if(boxMode)drawBoxSticker(page,font,codeFont,String(pageRows[slot].code),prefix,qr,slot,layout);
        else drawProductSticker(page,font,String(pageRows[slot].code),qr,slot,layout);
      }
    }
    const bytes=await pdf.save(); res.setHeader('Content-Type','application/pdf');
    // inline — для кнопки «Печать»: браузер открывает готовый лист в своём
    // просмотрщике, откуда печать идёт ровно тем же макетом, что и скачивание.
    const inline=String(req.query?.inline||'')==='1';
    res.setHeader('Content-Disposition',`${inline?'inline':'attachment'}; filename="shk-wb.pdf"`);
    res.setHeader('Cache-Control','private, no-store'); return res.status(200).send(Buffer.from(bytes));
  }catch(error){console.error(error);return res.status(502).end()}
};
