export type WalletNetwork = "stellar";

export interface Wallet {
  id: string;
  address: string;
  network: WalletNetwork;
  createdAt: Date;
}
