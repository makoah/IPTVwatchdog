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
  PLAYLIST_TOKEN: string;
}

export interface ByteWriter {
  write(chunk: Uint8Array): Promise<void> | void;
}
