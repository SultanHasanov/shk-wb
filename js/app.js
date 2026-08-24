(function () {
  'use strict';

  var quantity = document.getElementById('quantity');
  var error = document.getElementById('error');
  var generate = document.getElementById('generate');
  var download = document.getElementById('download');
  var shareSticker = document.getElementById('share-sticker');
  var customDownload = null;
  var preview = document.getElementById('sticker-preview');
  var accessPanel = document.getElementById('access-panel');
  var accessCode = document.getElementById('access-code');
  var tabRange = document.getElementById('tab-range');
  var tabCustom = document.getElementById('tab-custom');
  var tabProducts = document.getElementById('tab-products');
  var tabBoxes = document.getElementById('tab-boxes');
  var rangePanel = document.getElementById('range-panel');
  var customPanel = document.getElementById('custom-panel');
  var customCode = document.getElementById('custom-code');
  var customGenerate = document.getElementById('custom-generate');
  var boxRangePanel = document.getElementById('box-range-panel');
  var boxCustomPanel = document.getElementById('box-custom-panel');
  var boxQuantity = document.getElementById('box-quantity');
  var boxPrefix = document.getElementById('box-prefix');
  var boxGenerate = document.getElementById('box-generate');
  var boxCustomPrefix = document.getElementById('box-custom-prefix');
  var boxCustomCode = document.getElementById('box-custom-code');
  var boxCustomGenerate = document.getElementById('box-custom-generate');
  var printNiimbot = document.getElementById('print-niimbot');
  var printRegular = document.getElementById('print-regular');
  var printThermal = document.getElementById('print-thermal');
  var thermalSettings = document.getElementById('thermal-print-settings');
  var thermalLabelSize = document.getElementById('thermal-label-size');
  var thermalCustomSize = document.getElementById('thermal-custom-size');
  var thermalLabelWidth = document.getElementById('thermal-label-width');
  var thermalLabelHeight = document.getElementById('thermal-label-height');
  var thermalPrinterModel = document.getElementById('thermal-printer-model');
  var thermalWarning = document.getElementById('thermal-warning');
  var printStatus = document.getElementById('print-status');
  var printableImages = [];
  var THERMAL_STORAGE_KEY = 'sticker_thermal_print_settings';
  var ACCESS_STORAGE_KEY = 'sticker_access_code';
  var accessBalance = document.getElementById('access-balance');
  var accessBalanceTitle = document.getElementById('access-balance-title');
  var accessUsed = document.getElementById('access-used');
  var accessRemaining = document.getElementById('access-remaining');
  var accessStatus = null;
  var customMode = false;
  var productMode = true;
  var currentDesignHeight = 740;
  var accessIntro = document.getElementById('access-intro');
  var accessMessage = document.getElementById('access-status');
  var accessSuccess = document.getElementById('access-success');
  var accessCheckTimer = 0;
  var accessCheckSequence = 0;

  function setPrintControlsVisible(visible) {
    printNiimbot.hidden = !visible;
    printRegular.hidden = !visible;
    printThermal.hidden = !visible;
    thermalSettings.hidden = !visible;
  }

  function parseDecimal(value) {
    return Number(String(value).replace(',', '.'));
  }

  function getThermalSize() {
    var value = thermalLabelSize.value;
    var parts = value === 'custom' ? null : value.split('x');
    var width = parts ? Number(parts[0]) : parseDecimal(thermalLabelWidth.value);
    var height = parts ? Number(parts[1]) : parseDecimal(thermalLabelHeight.value);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 15 || width > 112 || height < 10 || height > 300) {
      return { error: 'Укажите ширину 15–112 мм и высоту 10–300 мм.' };
    }
    return { width: width, height: height };
  }

  function updateThermalSettings() {
    thermalCustomSize.hidden = thermalLabelSize.value !== 'custom';
    var size = getThermalSize();
    thermalLabelWidth.classList.toggle('invalid', Boolean(size.error) && thermalLabelSize.value === 'custom');
    thermalLabelHeight.classList.toggle('invalid', Boolean(size.error) && thermalLabelSize.value === 'custom');
    if (size.error) {
      thermalWarning.textContent = size.error;
      printThermal.disabled = true;
    } else {
      var limit = thermalPrinterModel.value === 'tdp225' ? 52 : thermalPrinterModel.value === 'te200' ? 108 : 0;
      thermalWarning.textContent = limit && size.width > limit
        ? 'Ширина этикетки ' + size.width + ' мм превышает предел этой модели (' + limit + ' мм). Выберите меньший размер.'
        : '';
      printThermal.disabled = Boolean(limit && size.width > limit);
    }
    try {
      localStorage.setItem(THERMAL_STORAGE_KEY, JSON.stringify({
        size: thermalLabelSize.value,
        width: thermalLabelWidth.value,
        height: thermalLabelHeight.value,
        printer: thermalPrinterModel.value
      }));
    } catch (_storageError) {}
  }

  function restoreThermalSettings() {
    try {
      var saved = JSON.parse(localStorage.getItem(THERMAL_STORAGE_KEY) || '{}');
      if (/^(40x30|50x30|50x40|58x40|75x58|100x75|custom)$/.test(saved.size || '')) thermalLabelSize.value = saved.size;
      if (saved.width !== undefined) thermalLabelWidth.value = saved.width;
      if (saved.height !== undefined) thermalLabelHeight.value = saved.height;
      if (/^(tdp225|te200|other)$/.test(saved.printer || '')) thermalPrinterModel.value = saved.printer;
    } catch (_storageError) {}
    updateThermalSettings();
  }

  function escapeAttribute(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function printOnThermalPrinter() {
    var size = getThermalSize();
    if (size.error || printThermal.disabled || !printableImages.length) return;
    var designRatio = 600 / currentDesignHeight;
    var pageRatio = size.width / size.height;
    var rotate = Math.abs(Math.log(pageRatio / (1 / designRatio))) < Math.abs(Math.log(pageRatio / designRatio));
    var imageWidth = rotate ? size.height : size.width;
    var imageHeight = rotate ? size.width : size.height;
    var safeWidth = Math.max(1, imageWidth - 2);
    var safeHeight = Math.max(1, imageHeight - 2);
    var images = printableImages.map(function (url) {
      return '<section class="label"><img src="' + escapeAttribute(new URL(url, window.location.href).href) + '" alt="Этикетка"></section>';
    }).join('');
    var popup = window.open('', '_blank');
    if (!popup) {
      printStatus.textContent = 'Браузер заблокировал окно печати. Разрешите всплывающие окна для сайта.';
      return;
    }
    popup.document.open();
    popup.document.write('<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Печать этикеток ' + size.width + ' × ' + size.height + ' мм</title><style>' +
      '@page{size:' + size.width + 'mm ' + size.height + 'mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}.label{position:relative;width:' + size.width + 'mm;height:' + size.height + 'mm;overflow:hidden;break-after:page;page-break-after:always}.label:last-child{break-after:auto;page-break-after:auto}.label img{position:absolute;left:50%;top:50%;width:' + safeWidth + 'mm;height:' + safeHeight + 'mm;object-fit:contain;transform:translate(-50%,-50%)' + (rotate ? ' rotate(90deg)' : '') + ';transform-origin:center}'+
      '</style></head><body>' + images + '<script>window.addEventListener("load",function(){setTimeout(function(){window.focus();window.print()},200)})<\/script></body></html>');
    popup.document.close();
    popup.opener = null;
    printStatus.textContent = 'Открыто окно термопечати: ' + size.width + ' × ' + size.height + ' мм.';
  }

  restoreThermalSettings();

  try {
    var savedAccessCode = localStorage.getItem(ACCESS_STORAGE_KEY) || '';
    if (/^\d{6}$/.test(savedAccessCode)) { accessCode.value = savedAccessCode; loadAccessStatus(); }
  } catch (_storageError) {}

  function rememberAccessCode() {
    var value = accessCode.value.trim();
    if (!/^\d{6}$/.test(value)) return;
    try { localStorage.setItem(ACCESS_STORAGE_KEY, value); } catch (_storageError) {}
    accessPanel.hidden = true;
    showAccessSuccess();
  }

  function setAccessMessage(text, type) {
    if (!accessMessage) return;
    accessMessage.textContent = text || '';
    accessMessage.className = 'access-status' + (type ? ' ' + type : '');
  }

  function showAccessSuccess() {
    accessPanel.hidden = true;
    if (accessSuccess) accessSuccess.hidden = false;
  }

  function showAccessPanel(message) {
    accessPanel.hidden = false;
    if (accessSuccess) accessSuccess.hidden = true;
    setAccessMessage(message || '', message ? 'error' : '');
  }

  function forgetAccessCode() {
    accessCode.value = '';
    try { localStorage.removeItem(ACCESS_STORAGE_KEY); } catch (_storageError) {}
    showAccessPanel('Ключ не подходит. Проверьте шесть цифр или купите новый пакет.');
    accessStatus = null;
    renderAccessStatus();
  }

  function renderAccessStatus() {
    if (!accessStatus) { accessBalance.hidden = true; return; }
    var balance = productMode ? (customMode ? accessStatus.custom : accessStatus.range) : (customMode ? accessStatus.boxCustom : accessStatus.boxRange);
    accessBalanceTitle.textContent = productMode ? (customMode ? 'Товар по номеру' : 'Стикеры товаров') : (customMode ? 'Коробка по номеру' : 'QR коробок');
    accessUsed.textContent = String(balance.used);
    accessRemaining.textContent = String(balance.remaining);
    accessBalance.hidden = false;
  }

  function updateAccessStatus(status) {
    if (status) accessStatus = status;
    renderAccessStatus();
  }

  function loadAccessStatus() {
    var code = accessCode.value.trim();
    var sequence = ++accessCheckSequence;
    if (!/^\d{6}$/.test(code)) { accessStatus = null; renderAccessStatus(); if(code.length)setAccessMessage('Введите все 6 цифр.',''); return; }
    setAccessMessage('Проверяем ключ…', 'loading');
    if (accessIntro) accessIntro.textContent = 'Проверяем ключ доступа.';
    fetch('/api/stickers/generate?accessCode=' + encodeURIComponent(code))
      .then(function (response) { return response.json().catch(function(){return {};}).then(function(body){if(!response.ok){var e=new Error(body.error||'Ключ не найден');e.status=response.status;throw e;}return body;}); })
      .then(function (data) {
        if(sequence!==accessCheckSequence)return;
        updateAccessStatus(data.access);
        var balance=productMode?(customMode?data.access.custom:data.access.range):(customMode?data.access.boxCustom:data.access.boxRange);
        if(balance.remaining<1){showAccessPanel('Лимит для режима «'+(customMode?'По номеру':'Возвратные')+'» исчерпан. Выберите другой ключ или купите новый пакет.');return;}
        rememberAccessCode();setAccessMessage('', '');
      })
      .catch(function (reason) { if(sequence!==accessCheckSequence)return;accessStatus=null;renderAccessStatus();showAccessPanel(reason.status===404?'Такой ключ не найден. Проверьте введённые цифры.':'Не удалось проверить ключ. Попробуйте ещё раз.'); });
  }

  function handleAccessError(body) {
    if (body.code === 'INVALID_ACCESS_CODE') { forgetAccessCode(); showAccessPanel('Такой ключ не найден. Проверьте введённые цифры.'); }
    else if (body.code === 'ACCESS_CODE_LIMIT') { try { localStorage.removeItem(ACCESS_STORAGE_KEY); } catch (_error) {} showAccessPanel('Лимит этого ключа исчерпан. Купите новый пакет.'); }
    else if (body.code === 'ACCESS_CODE_REQUIRED') showAccessPanel('Бесплатный лимит исчерпан. Введите ключ или купите пакет.');
  }

  function setBusy(busy) {
    generate.disabled = busy;
    generate.textContent = busy ? 'Генерируем…' : 'Сгенерировать';
  }

  function switchMode(custom) {
    customDownload = null;
    customMode = custom;
    rangePanel.hidden = !productMode || custom;
    customPanel.hidden = !productMode || !custom;
    boxRangePanel.hidden = productMode || custom;
    boxCustomPanel.hidden = productMode || !custom;
    tabRange.classList.toggle('active', !custom);
    tabCustom.classList.toggle('active', custom);
    error.textContent = '';
    download.hidden = true;
    shareSticker.hidden = true;
    setPrintControlsVisible(false);
    printableImages = [];
    renderAccessStatus();
    if(/^\d{6}$/.test(accessCode.value.trim()))loadAccessStatus();
  }

  function showCategoryExample() {
    var box=!productMode;
    preview.innerHTML='<div class="empty-state"><figure class="sticker-example"><figcaption>'+(box?'Пример QR для возвратной коробки':'Пример товарного стикера')+'</figcaption><img src="'+(box?'/api/stickers/image?example=1&variant=box&prefix=TRBX&v=4':'/api/stickers/image?example=1&v=4')+'" alt="'+(box?'Пример этикетки возвратной коробки B-T с кодом TRBX':'Пример готового стикера для товара')+'" width="330" height="'+(box?'495':'407')+'"></figure><p class="empty-state-title">Здесь появятся ваши '+(box?'QR-коды для коробок':'стикеры для товаров')+'</p><p class="empty-state-copy">'+(box?'Выберите массовую генерацию или режим по номеру. Префикс TRBX можно изменить.':'Выберите массовую генерацию или режим по номеру и создайте товарные стикеры.')+'</p><a class="empty-state-link" href="#payment-section">Пакеты от 0,27 ₽ за стикер</a></div>';
  }

  function switchCategory(products) {
    var changed=productMode!==products;
    productMode = products;
    tabProducts.classList.toggle('active', products);
    tabBoxes.classList.toggle('active', !products);
    switchMode(customMode);
    if(changed)showCategoryExample();
  }

  function showBatch(data) {
    customDownload = null;
    if (accessCode.value.trim()) rememberAccessCode();
    preview.innerHTML = '';
    currentDesignHeight = data.variant === 'box' ? 900 : 740;
    printableImages = data.stickers.map(function (sticker) { return sticker.imageUrl; });
    data.stickers.forEach(function (sticker) {
      var figure = document.createElement('figure');
      figure.className = 'sticker-card';
      var image = document.createElement('img');
      image.src = sticker.imageUrl;
      image.alt = 'Возвратный стикер ' + sticker.code;
      image.loading = 'lazy';
      figure.appendChild(image);
      preview.appendChild(figure);
    });
    download.href = data.pdfUrl;
    download.removeAttribute('download');
    download.classList.remove('icon-btn');
    download.removeAttribute('title');
    download.removeAttribute('aria-label');
    download.textContent = 'Скачать PDF A4';
    download.hidden = false;
    shareSticker.hidden = true;
    setPrintControlsVisible(true);
    if (Number(data.freeRemaining) === 0 && !accessCode.value.trim()) accessPanel.hidden = false;
    updateAccessStatus(data.access);
    window.dispatchEvent(new CustomEvent('sticker:generated'));
  }

  function cleanPrefix(input) {
    input.value=input.value.toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,12);
    return input.value;
  }

  function createBoxBatch() {
    var count=Number(boxQuantity.value),prefix=cleanPrefix(boxPrefix);
    error.textContent='';download.hidden=true;shareSticker.hidden=true;setPrintControlsVisible(false);printableImages=[];
    if(!Number.isInteger(count)||count<1||count>500){error.textContent='Введите количество от 1 до 500.';return;}
    if(!prefix){error.textContent='Введите префикс.';return;}
    boxGenerate.disabled=true;boxGenerate.textContent='Генерируем…';
    fetch('/api/stickers/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'box_range',quantity:count,prefix:prefix,accessCode:accessCode.value.trim()})})
      .then(function(response){return response.json().then(function(body){if(!response.ok){handleAccessError(body);throw new Error(body.error||'Не удалось создать QR коробок');}return body;});})
      .then(showBatch).catch(function(reason){error.textContent=reason.message||'Ошибка связи с сервером.';})
      .then(function(){boxGenerate.disabled=false;boxGenerate.textContent='Сгенерировать пачку';});
  }

  function createBoxCustom() {
    var prefix=cleanPrefix(boxCustomPrefix),code=boxCustomCode.value.replace(/\D/g,'').slice(0,12);boxCustomCode.value=code;
    error.textContent='';download.hidden=true;shareSticker.hidden=true;setPrintControlsVisible(false);printableImages=[];
    if(!prefix||!/^\d{1,12}$/.test(code)){error.textContent='Укажите префикс и номер коробки от 1 до 12 цифр.';return;}
    boxCustomGenerate.disabled=true;boxCustomGenerate.textContent='Генерируем…';
    fetch('/api/stickers/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'box_custom',prefix:prefix,code:code,accessCode:accessCode.value.trim()})})
      .then(function(response){return response.json().then(function(body){if(!response.ok){handleAccessError(body);throw new Error(body.error||'Не удалось создать QR коробки');}return body;});})
      .then(function(data){
        if(accessCode.value.trim())rememberAccessCode();preview.innerHTML='';currentDesignHeight=900;
        var figure=document.createElement('figure');figure.className='sticker-card';var image=document.createElement('img');image.src=data.imageUrl;image.alt='QR коробки '+data.prefix+data.code;figure.appendChild(image);preview.appendChild(figure);
        customDownload={imageUrl:data.imageUrl,code:data.prefix+data.code,height:900,box:true};download.href=data.imageUrl;download.download='box-qr-'+data.prefix+data.code+'.png';download.classList.add('icon-btn');download.title='Скачать PNG';download.setAttribute('aria-label','Скачать PNG');download.innerHTML='<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14"/></svg>';download.hidden=false;shareSticker.hidden=false;printableImages=[data.imageUrl];setPrintControlsVisible(true);updateAccessStatus(data.access);window.dispatchEvent(new CustomEvent('sticker:generated'));
      }).catch(function(reason){error.textContent=reason.message||'Ошибка связи с сервером.';}).then(function(){boxCustomGenerate.disabled=false;boxCustomGenerate.textContent='Сгенерировать QR коробки';});
  }

  function createBatch() {
    var count = Number(quantity.value);
    error.textContent = '';
    download.hidden = true;
    shareSticker.hidden = true;
    setPrintControlsVisible(false);
    printableImages = [];
    if (!Number.isInteger(count) || count < 1 || count > 500) {
      error.textContent = 'Введите количество от 1 до 500.';
      return;
    }
    setBusy(true);
    fetch('/api/stickers/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: count, accessCode: accessCode.value.trim() }),
    }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) {
          handleAccessError(body);
          throw new Error(body.error || 'Не удалось создать стикеры');
        }
        return body;
      });
    }).then(showBatch).catch(function (reason) {
      error.textContent = reason.message || 'Ошибка связи с сервером.';
    }).then(function () { setBusy(false); });
  }

  function createCustom() {
    var code = customCode.value.trim();
    error.textContent = '';
    download.hidden = true;
    shareSticker.hidden = true;
    setPrintControlsVisible(false);
    printableImages = [];
    if (!/^\d{11}$/.test(code)) {
      error.textContent = 'Введите номер из 11 цифр.';
      return;
    }
    customGenerate.disabled = true;
    customGenerate.textContent = 'Генерируем…';
    fetch('/api/stickers/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'custom', code: code, accessCode: accessCode.value.trim() }),
    }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) {
          handleAccessError(body);
          throw new Error(body.error || 'Не удалось создать QR');
        }
        return body;
      });
    }).then(function (data) {
      if (accessCode.value.trim()) rememberAccessCode();
      preview.innerHTML = '';
      var figure = document.createElement('figure'); figure.className = 'sticker-card';
      var image = document.createElement('img'); image.src = data.imageUrl; image.alt = 'Стикер ' + data.code;
      figure.appendChild(image); preview.appendChild(figure);
      customDownload = { imageUrl: data.imageUrl, code: data.code };
      download.href = data.imageUrl; download.download = 'wb-sticker-' + data.code + '.png';
      download.classList.add('icon-btn');
      download.title = 'Скачать PNG';
      download.setAttribute('aria-label', 'Скачать PNG');
      download.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14"/></svg>';
      download.hidden = false; shareSticker.hidden = false;
      printableImages = [data.imageUrl]; setPrintControlsVisible(true);
      if (Number(data.freeRemaining) === 0 && !accessCode.value.trim()) accessPanel.hidden = false;
      updateAccessStatus(data.access);
      window.dispatchEvent(new CustomEvent('sticker:generated'));
    }).catch(function (reason) {
      error.textContent = reason.message || 'Ошибка связи с сервером.';
    }).then(function () {
      customGenerate.disabled = false; customGenerate.textContent = 'Сгенерировать QR';
    });
  }

  function createPngBlob(item) {
    return fetch(item.imageUrl).then(function (response) {
      if (!response.ok) throw new Error('Не удалось загрузить стикер');
      return response.blob();
    }).then(function (svgBlob) {
      return new Promise(function (resolve, reject) {
        var objectUrl = URL.createObjectURL(svgBlob);
        var image = new Image();
        image.onload = function () {
          var canvas = document.createElement('canvas');
          canvas.width = 600;
          canvas.height = item.height || 740;
          var context = canvas.getContext('2d');
          context.fillStyle = '#fff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(objectUrl);
          canvas.toBlob(function (pngBlob) {
            if (pngBlob) resolve(pngBlob);
            else reject(new Error('Не удалось создать PNG'));
          }, 'image/png');
        };
        image.onerror = function () {
          URL.revokeObjectURL(objectUrl);
          reject(new Error('Не удалось открыть стикер'));
        };
        image.src = objectUrl;
      });
    });
  }

  generate.addEventListener('click', createBatch);
  tabProducts.addEventListener('click', function(){switchCategory(true);});
  tabBoxes.addEventListener('click', function(){switchCategory(false);});
  tabRange.addEventListener('click', function () { switchMode(false); });
  tabCustom.addEventListener('click', function () { switchMode(true); });
  customGenerate.addEventListener('click', createCustom);
  boxGenerate.addEventListener('click',createBoxBatch);
  boxCustomGenerate.addEventListener('click',createBoxCustom);
  boxPrefix.addEventListener('input',function(){cleanPrefix(boxPrefix);});
  boxCustomPrefix.addEventListener('input',function(){cleanPrefix(boxCustomPrefix);});
  boxCustomCode.addEventListener('input',function(){boxCustomCode.value=boxCustomCode.value.replace(/\D/g,'').slice(0,12);});
  download.addEventListener('click', function (event) {
    if (!customDownload) return;
    event.preventDefault();
    var item = customDownload;
    download.setAttribute('aria-busy', 'true');
    createPngBlob(item).then(function (pngBlob) {
      var pngUrl = URL.createObjectURL(pngBlob);
      var anchor = document.createElement('a');
      anchor.href = pngUrl;
      anchor.download = (item.box ? 'box-qr-' : 'wb-sticker-') + item.code + '.png';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(function () { URL.revokeObjectURL(pngUrl); }, 1000);
    }).catch(function (reason) {
      error.textContent = reason.message || 'Не удалось скачать PNG.';
    }).then(function () {
      download.removeAttribute('aria-busy');
    });
  });
  shareSticker.addEventListener('click', function () {
    if (!customDownload) return;
    var item = customDownload;
    shareSticker.disabled = true;
    createPngBlob(item).then(function (pngBlob) {
      var file = new File([pngBlob], (item.box ? 'box-qr-' : 'wb-sticker-') + item.code + '.png', { type: 'image/png' });
      if (!navigator.share || (navigator.canShare && !navigator.canShare({ files: [file] }))) {
        throw new Error('Браузер не поддерживает отправку файлов. Скачайте PNG и отправьте его вручную.');
      }
      return navigator.share({ files: [file], title: (item.box ? 'QR коробки ' : 'Стикер WB ') + item.code });
    }).catch(function (reason) {
      if (reason && reason.name === 'AbortError') return;
      error.textContent = reason.message || 'Не удалось поделиться стикером.';
    }).then(function () {
      shareSticker.disabled = false;
    });
  });
  quantity.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') createBatch();
  });
  customCode.addEventListener('keydown', function (event) { if (event.key === 'Enter') createCustom(); });
  accessCode.addEventListener('input', function () {
    accessCode.value=accessCode.value.replace(/\D/g,'').slice(0,6);
    clearTimeout(accessCheckTimer);accessCheckSequence+=1;if(accessSuccess)accessSuccess.hidden=true;accessPanel.hidden=false;
    if(accessCode.value.length<6){setAccessMessage(accessCode.value.length?'Введите все 6 цифр.':'','');return;}
    accessCheckTimer=setTimeout(loadAccessStatus,350);
  });
  printRegular.addEventListener('click', function () { window.print(); });
  printThermal.addEventListener('click', printOnThermalPrinter);
  thermalLabelSize.addEventListener('change', updateThermalSettings);
  thermalLabelWidth.addEventListener('input', updateThermalSettings);
  thermalLabelHeight.addEventListener('input', updateThermalSettings);
  thermalPrinterModel.addEventListener('change', updateThermalSettings);
  printNiimbot.addEventListener('click', function () {
    if (!printableImages.length) return;
    printStatus.textContent = '';
    printNiimbot.disabled = true;
    window.NiimbotWeb.printImages(printableImages, function (current, total) {
      printStatus.textContent = 'Печать этикетки ' + current + ' из ' + total + '…';
    }).then(function () {
      printStatus.textContent = 'Все этикетки отправлены на NIIMBOT.';
    }).catch(function (reason) {
      printStatus.textContent = reason.message || 'Не удалось напечатать этикетки.';
    }).then(function () { printNiimbot.disabled = false; });
  });
})();
