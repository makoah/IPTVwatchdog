export interface WishlistItem {
  title: string;
  year?: string;
}

export interface Selection {
  keep_categories: string[];
  wishlist: WishlistItem[];
  series: string[];
  match_threshold?: number;
  year_bonus?: number;
  year_penalty?: number;
}

export interface M3uEntry {
  extinf: string;
  url: string;
  title: string;
  group: string;
  tvgId: string;
}

export interface RefreshStats {
  scanned: number;
  selected: number;
  channels: number;
  epgProgrammes: number;
  epgAvailable: boolean;
}

export interface Env {
  CURATOR_BUCKET: R2Bucket;
  CURATOR_CONFIG: KVNamespace;
  M3U_URL: string;
  EPG_URL?: string;
  PLAYLIST_TOKEN: string;
  ADMIN_TOKEN: string;
  PUBLIC_BASE_URL: string;
}
