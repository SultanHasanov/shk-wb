(function(){'use strict';
  var section=document.getElementById('payment-section');if(!section)return;
  var open=document.getElementById('open-payment'),range=document.getElementById('buy-range'),custom=document.getElementById('buy-custom'),consent=document.getElementById('buy-consent'),submit=document.getElementById('buy-submit'),breakdown=document.getElementById('payment-breakdown'),error=document.getElementById('payment-error'),prices={},target='product';
  function money(value){return Number(value).toFixed(0)+' ₽';}
  function fill(select,packages){packages.forEach(function(item){prices[item.quantity]=item.total;var option=document.createElement('option');option.value=String(item.quantity);option.textContent=item.quantity+' шт. — '+money(item.total);select.appendChild(option);});}
  function calc(){var r=Number(range.value)||0,c=Number(custom.value)||0,rv=r?prices[r]||0:0,cv=c?prices[c]||0:0,total=rv+cv;breakdown.innerHTML='<span>Массово: '+money(rv)+'</span><span>По номеру: '+money(cv)+'</span><strong>Итого: '+money(total)+'</strong>';return total;}
  function setTarget(value){target=value;document.getElementById('buy-target-product').classList.toggle('active',value==='product');document.getElementById('buy-target-box').classList.toggle('active',value==='box');document.getElementById('buy-range-label').textContent=value==='box'?'QR коробок массово':'Товарные стикеры массово';document.getElementById('buy-custom-label').textContent=value==='box'?'QR коробок по номеру':'Товарные стикеры по номеру';}
  /* Оплата включается/выключается тумблером в админке. Выключена — секцию не показываем.
     Прошлое состояние помним в localStorage, чтобы блок не мигал при загрузке. */
  function remember(enabled){try{localStorage.setItem('payments_enabled',enabled?'1':'0');}catch(e){}}
  function hideAll(){
    remember(false);
    document.documentElement.classList.add('payments-off');
    section.hidden=true;
    Array.prototype.forEach.call(document.querySelectorAll('a[href="#payment-section"]'),function(link){link.hidden=true;});
  }
  function showAll(){
    remember(true);
    document.documentElement.classList.remove('payments-off');
    section.hidden=false;open.hidden=false;
    Array.prototype.forEach.call(document.querySelectorAll('a[href="#payment-section"]'),function(link){link.hidden=false;});
  }
  function fillCards(){
    Array.prototype.forEach.call(document.querySelectorAll('.pkg-card'),function(card){
      var qty=Number(card.getAttribute('data-pkg'))||0,total=prices[qty];
      if(!total){card.hidden=true;return;}
      card.hidden=false;
      card.querySelector('[data-pkg-price]').textContent=money(total);
      card.querySelector('[data-pkg-unit]').textContent=(total/qty).toFixed(2).replace('.',',')+' ₽ за стикер';
      card.onclick=function(){range.value=String(qty);calc();markCards();range.focus();};
    });
  }
  function markCards(){
    Array.prototype.forEach.call(document.querySelectorAll('.pkg-card'),function(card){
      card.classList.toggle('is-selected',card.getAttribute('data-pkg')===String(Number(range.value)||0));
    });
  }
  /* Отладка вёрстки блока оплаты на localhost: /?debugPayments=1 показывает секцию
     даже при выключенном тумблере. Цены берутся настоящие — сервер отдаёт их и в выключенном
     состоянии. Кнопка «Перейти к оплате» при этом честно вернёт ошибку с сервера. */
  var debugPayments=/^(localhost|127\.0\.0\.1)$/.test(location.hostname)&&/[?&]debugPayments=1(&|$)/.test(location.search);
  fetch('/api/payments/config').then(function(response){return response.json();}).then(function(config){
    if(!config.enabled&&!debugPayments){hideAll();return;}
    fill(range,config.packages||[]);fill(custom,config.packages||[]);
    fillCards();calc();showAll();
  }).catch(function(){hideAll();});
  [range,custom].forEach(function(select){select.addEventListener('change',function(){calc();markCards();});});open.onclick=function(){section.scrollIntoView({behavior:'smooth'});};
  document.getElementById('buy-target-product').onclick=function(){setTarget('product')};document.getElementById('buy-target-box').onclick=function(){setTarget('box')};
  submit.onclick=function(){error.textContent='';var r=Number(range.value)||0,c=Number(custom.value)||0;if(r+c<1){error.textContent='Выберите хотя бы один пакет.';return;}submit.disabled=true;fetch('/api/payments/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rangeQuantity:r,customQuantity:c,stickerTarget:target,accepted:consent.checked})}).then(function(response){return response.json().then(function(body){if(!response.ok)throw new Error(body.error||'Ошибка оплаты');return body;});}).then(function(data){location.href=data.confirmationUrl;}).catch(function(reason){error.textContent=reason.message;}).then(function(){submit.disabled=false;});};
})();
