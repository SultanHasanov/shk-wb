import { makeAutoObservable } from 'mobx';
import { createContext, useContext } from 'react';
import { AuthStore } from '../auth/auth-store';
export type StickerKind = 'product' | 'box';
export type GenerationMode = 'range' | 'custom';

/**
 * Потолок одной массовой генерации. Тот же предел стоит в api/stickers/generate.js
 * и в allocate_return_stickers — расхождение между слоями уже приводило к 502:
 * форма пропускала количество, которое отвергала база.
 */
export const MAX_BATCH_QUANTITY = 500;

/** Длина номера при генерации по номеру: у коробок 10 цифр, у товаров 11. */
export const CUSTOM_CODE_LENGTH: Readonly<Record<StickerKind, number>> = Object.freeze({
  product: 11,
  box: 10,
});
class UiStore {
  sidebarOpen = false;
  sidebarCollapsed = localStorage.getItem('sidebar-collapsed') === '1';
  constructor() {
    makeAutoObservable(this);
  }
  toggleMobile = () => {
    this.sidebarOpen = !this.sidebarOpen;
  };
  closeMobile = () => {
    this.sidebarOpen = false;
  };
  toggleCollapsed = () => {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    localStorage.setItem('sidebar-collapsed', this.sidebarCollapsed ? '1' : '0');
  };
}
class GeneratorStore {
  kind: StickerKind = 'product';
  mode: GenerationMode = 'range';
  quantity = 1;
  code = '';
  prefix = 'TRBX';
  accessCode = localStorage.getItem('sticker_access_code') || '';
  constructor() {
    makeAutoObservable(this);
  }
  setKind(v: StickerKind) {
    this.kind = v;
    // Иначе набранный номер товара оставался бы в поле коробки на 11 цифр при
    // пределе в 10: кнопка заблокирована, а править надо вручную.
    this.code = this.code.slice(0, CUSTOM_CODE_LENGTH[v]);
  }
  setMode(v: GenerationMode) {
    this.mode = v;
  }
}
class PurchaseStore {
  productKind = 'cell_print_license';
  durationDays = 30;
  deviceLimit = 1;
  promoCode = '';
  constructor() {
    makeAutoObservable(this);
  }
}
export class RootStore {
  ui = new UiStore();
  auth: AuthStore;
  generator = new GeneratorStore();
  purchase = new PurchaseStore();
  constructor(initializeAuth = true) {
    this.auth = new AuthStore(initializeAuth);
  }
}
const store = new RootStore();
const StoreContext = createContext(store);
export const useStores = () => useContext(StoreContext);
export const rootStore = store;
