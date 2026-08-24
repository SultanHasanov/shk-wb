const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { qrPng, qrTextPng, returnStickerDesign, stickerDecorations, splitCode } = require('../_stickers');
const { supabaseFetch } = require('../_supabase');

const mm = (value) => value * 72 / 25.4;
const A4_WIDTH = mm(210);
const A4_HEIGHT = mm(297);
const MARGIN = mm(8);
const COLUMNS = 4;
const ROWS = 3;
const PER_PAGE = COLUMNS * ROWS;
const GAP = mm(2);
const CELL_WIDTH = (A4_WIDTH - 2 * MARGIN - GAP * (COLUMNS - 1)) / COLUMNS;
const CELL_HEIGHT = (A4_HEIGHT - 2 * MARGIN - GAP * (ROWS - 1)) / ROWS;
const STICKER_WIDTH = CELL_WIDTH;
const STICKER_HEIGHT = STICKER_WIDTH * 900 / 600;

function drawBoxSticker(page, font, codeFont, code, prefix, qr, slot) {
  const column = slot % COLUMNS;
  const row = Math.floor(slot / COLUMNS);
  const originX = MARGIN + column * (CELL_WIDTH + GAP);
  const cellBottom = A4_HEIGHT - MARGIN - (row + 1) * CELL_HEIGHT - row * GAP;
  const originY = cellBottom + (CELL_HEIGHT - STICKER_HEIGHT) / 2;
  const sx = STICKER_WIDTH / 600;
  const sy = STICKER_HEIGHT / 900;
  const design = returnStickerDesign(code);
  design.displayCode=prefix+code;

  page.drawRectangle({ x:originX, y:originY, width:STICKER_WIDTH, height:STICKER_HEIGHT,
    color:rgb(1,1,1), borderColor:rgb(.86,.86,.88), borderWidth:.4 });
  const centered = (text,y,size,selectedFont=font) => page.drawText(text,{x:originX+(STICKER_WIDTH-selectedFont.widthOfTextAtSize(text,size))/2,y:originY+y*sy,size,font:selectedFont,color:rgb(.07,.07,.07)});
  centered(design.title, 752, 18, font);
  page.drawImage(qr, { x:originX+design.qr.x*sx, y:originY+STICKER_HEIGHT-(design.qr.y+design.qr.size)*sy,
    width:design.qr.size*sx, height:design.qr.size*sy });
  const maxWidth=STICKER_WIDTH-8*sx;
  let codeSize=11;
  while(codeSize>7&&codeFont.widthOfTextAtSize(design.displayCode,codeSize)>maxWidth)codeSize-=.5;
  centered(design.displayCode, 75, codeSize, codeFont);
}

function drawProductSticker(page,font,code,qr,slot){
  const column=slot%COLUMNS,row=Math.floor(slot/COLUMNS),originX=MARGIN+column*(CELL_WIDTH+GAP),cellBottom=A4_HEIGHT-MARGIN-(row+1)*CELL_HEIGHT-row*GAP;
  const productHeight=STICKER_WIDTH*740/600,originY=cellBottom+(CELL_HEIGHT-productHeight)/2,sx=STICKER_WIDTH/600,sy=productHeight/740,design=stickerDecorations(code);
  const drawRects=(items,color)=>items.forEach(item=>page.drawRectangle({x:originX+item.x*sx,y:originY+productHeight-(item.y+item.height)*sy,width:item.width*sx,height:item.height*sy,color}));
  page.drawRectangle({x:originX,y:originY,width:STICKER_WIDTH,height:productHeight,color:rgb(1,1,1),borderColor:rgb(.86,.86,.88),borderWidth:.4});
  drawRects(design.left.bars,rgb(0,0,0));drawRects(design.right.bars,rgb(0,0,0));drawRects(design.left.cuts,rgb(1,1,1));drawRects(design.right.cuts,rgb(1,1,1));
  const wbSize=24,wb='wb';page.drawText(wb,{x:originX+(STICKER_WIDTH-font.widthOfTextAtSize(wb,wbSize))/2,y:originY+productHeight-140*sy,size:wbSize,font,color:rgb(.898,0,.49)});
  design.corners.forEach(corner=>page.drawImage(qr,{x:originX+corner.x*sx,y:originY+productHeight-(corner.y+design.cornerSize)*sy,width:design.cornerSize*sx,height:design.cornerSize*sy}));
  page.drawRectangle({x:originX+118*sx,y:originY+productHeight-534*sy,width:364*sx,height:364*sy,color:rgb(1,1,1)});
  page.drawImage(qr,{x:originX+design.qr.x*sx,y:originY+productHeight-(design.qr.y+design.qr.size)*sy,width:design.qr.size*sx,height:design.qr.size*sy});
  const parts=splitCode(code),centered=(text,y,size)=>page.drawText(text,{x:originX+(STICKER_WIDTH-font.widthOfTextAtSize(text,size))/2,y:originY+y*sy,size,font,color:rgb(0,0,0)});
  if(parts[1]){centered(parts[0],123,11);centered(parts[1],49,17)}else centered(parts[0],69,16);
}

module.exports = async function handler(req,res){
  if(req.method!=='GET')return res.status(405).end();
  const batch=String(req.query?.batch||''); if(!/^[0-9a-f-]{36}$/i.test(batch))return res.status(400).end();
  const boxMode=String(req.query?.variant||'')==='box',prefix=String(req.query?.prefix||'TRBX').toUpperCase();
  if(boxMode&&!/^[A-Z0-9_-]{1,12}$/.test(prefix))return res.status(400).end();
  try{
    const table=boxMode?'return_box_codes':'return_sticker_codes';
    const rows=await supabaseFetch(`${table}?batch_id=eq.${encodeURIComponent(batch)}&select=code&order=code.asc`);
    if(!rows.length)return res.status(404).end(); if(rows.length>500)return res.status(413).end();
    const pdf=await PDFDocument.create();
    const font=await pdf.embedFont(StandardFonts.HelveticaBold);
    const codeFont=await pdf.embedFont(StandardFonts.CourierBold);
    let page;
    for(let pageStart=0;pageStart<rows.length;pageStart+=PER_PAGE){
      page=pdf.addPage([A4_WIDTH,A4_HEIGHT]);
      const pageRows=rows.slice(pageStart,pageStart+PER_PAGE);
      const qrBuffers=await Promise.all(pageRows.map((row)=>boxMode?qrTextPng(prefix+row.code,504,1):qrPng(row.code,504,1)));
      for(let slot=0;slot<pageRows.length;slot+=1){
        const qr=await pdf.embedPng(qrBuffers[slot]);
        if(boxMode)drawBoxSticker(page,font,codeFont,String(pageRows[slot].code),prefix,qr,slot);
        else drawProductSticker(page,font,String(pageRows[slot].code),qr,slot);
      }
    }
    const bytes=await pdf.save(); res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="return-stickers-a4-${batch}.pdf"`);
    res.setHeader('Cache-Control','private, no-store'); return res.status(200).send(Buffer.from(bytes));
  }catch(error){console.error(error);return res.status(502).end()}
};
