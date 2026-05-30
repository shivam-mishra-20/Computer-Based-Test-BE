// YouTube Data API service for fetching video metadata
// Uses YouTube Data API v3

import axios from 'axios';
import { logger } from '../utils/logger';
import { enqueue, registerJobHandler, YouTubeMetaJobPayload } from './jobQueue';
import Course from '../models/Course';

const YOUTUBE_API_KEY = process.env.YOUTUBE_DATA_API;
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

// ─── Playlist Types ───────────────────────────────────────────────────────────

export interface PlaylistMeta {
  playlistId: string;
  title: string;
  description: string;
  thumbnail: string;
  channelId: string;
  channelName: string;
  totalVideos: number;
  publishedAt: string;
}

export interface PlaylistVideo {
  videoId: string;
  title: string;
  description: string;
  thumbnail: string;
  position: number;
  publishedAt: string;
  durationSec: number;
}

// ─── Playlist Helpers ─────────────────────────────────────────────────────────

export function extractPlaylistId(urlOrId: string): string | null {
  if (!urlOrId) return null;
  const value = urlOrId.trim();

  // Already a raw playlist ID (PL, OL, UU, LL, FL, RD prefixes)
  if (/^(PL|OL|UU|LL|FL|RD)[a-zA-Z0-9_-]+$/.test(value)) return value;

  // Extract from any YouTube URL containing list=
  const match = value.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function ytErrorMessage(err: any): string {
  return (
    err?.response?.data?.error?.errors?.[0]?.message ||
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    err?.message ||
    'Unknown YouTube API error'
  );
}

export async function fetchPlaylistMeta(playlistId: string): Promise<PlaylistMeta> {
  if (!YOUTUBE_API_KEY) throw new Error('YouTube API key is not configured on the server');

  let response: any;
  try {
    response = await axios.get(`${YOUTUBE_API_BASE}/playlists`, {
      params: { part: 'snippet,contentDetails', id: playlistId, key: YOUTUBE_API_KEY },
    });
  } catch (err: any) {
    const msg = ytErrorMessage(err);
    logger.error('YouTube playlists.list failed', { playlistId, status: err?.response?.status, msg });
    throw new Error(`YouTube API error: ${msg}`);
  }

  const items = response.data?.items;
  if (!items || items.length === 0) {
    throw new Error('Playlist not found, is private, or has been deleted');
  }

  const pl = items[0];
  const sn = pl.snippet;
  return {
    playlistId: pl.id,
    title: sn.title,
    description: sn.description || '',
    thumbnail:
      sn.thumbnails?.maxres?.url ||
      sn.thumbnails?.high?.url ||
      sn.thumbnails?.medium?.url ||
      sn.thumbnails?.default?.url ||
      '',
    channelId: sn.channelId,
    channelName: sn.channelTitle,
    totalVideos: pl.contentDetails?.itemCount ?? 0,
    publishedAt: sn.publishedAt,
  };
}

export async function fetchPlaylistVideos(playlistId: string): Promise<PlaylistVideo[]> {
  if (!YOUTUBE_API_KEY) throw new Error('YouTube API key is not configured on the server');

  const rawVideos: Omit<PlaylistVideo, 'durationSec'>[] = [];
  let pageToken: string | undefined;

  // Step 1: Collect all playlist items (paginated, YouTube max 50/page)
  do {
    let resp: any;
    try {
      resp = await axios.get(`${YOUTUBE_API_BASE}/playlistItems`, {
        params: {
          part: 'snippet,contentDetails',
          playlistId,
          maxResults: 50,
          pageToken,
          key: YOUTUBE_API_KEY,
        },
      });
    } catch (err: any) {
      const msg = ytErrorMessage(err);
      logger.error('YouTube playlistItems.list failed', { playlistId, status: err?.response?.status, msg });
      throw new Error(`YouTube API error: ${msg}`);
    }

    for (const item of resp.data?.items ?? []) {
      const sn = item.snippet;
      const videoId: string = sn?.resourceId?.videoId || item.contentDetails?.videoId;

      // Skip deleted/private placeholder entries
      if (!videoId || sn?.title === 'Deleted video' || sn?.title === 'Private video') continue;

      rawVideos.push({
        videoId,
        title: sn.title,
        description: sn.description || '',
        thumbnail:
          sn.thumbnails?.high?.url ||
          sn.thumbnails?.medium?.url ||
          sn.thumbnails?.default?.url ||
          `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
        position: sn.position ?? rawVideos.length,
        publishedAt: sn.publishedAt || new Date().toISOString(),
      });
    }

    pageToken = resp.data?.nextPageToken;
  } while (pageToken);

  if (rawVideos.length === 0) return [];

  // Step 2: Fetch durations in batches of 50 via videos.list
  const durationMap = new Map<string, number>();
  const ids = rawVideos.map(v => v.videoId);

  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const resp = await axios.get(`${YOUTUBE_API_BASE}/videos`, {
      params: { part: 'contentDetails', id: batch.join(','), key: YOUTUBE_API_KEY },
    });
    for (const item of resp.data?.items ?? []) {
      durationMap.set(item.id, parseDuration(item.contentDetails?.duration || ''));
    }
  }

  return rawVideos
    .sort((a, b) => a.position - b.position)
    .map(v => ({ ...v, durationSec: durationMap.get(v.videoId) ?? 0 }));
}

export interface YouTubeMeta {
  title: string;
  description: string;
  durationSec: number;
  thumbnail: string;
  channelTitle: string;
  publishedAt: string;
  viewCount: number;
  tags: string[];
}

// Parse ISO 8601 duration (PT1H2M30S) to seconds
function parseDuration(duration: string): number {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  
  return hours * 3600 + minutes * 60 + seconds;
}

export async function fetchYouTubeMeta(videoId: string): Promise<YouTubeMeta | null> {
  if (!YOUTUBE_API_KEY) {
    logger.error('YouTube API key not configured');
    return null;
  }
  
  try {
    const response = await axios.get(`${YOUTUBE_API_BASE}/videos`, {
      params: {
        part: 'snippet,contentDetails,statistics',
        id: videoId,
        key: YOUTUBE_API_KEY
      }
    });
    
    const items = response.data?.items;
    if (!items || items.length === 0) {
      logger.warn('YouTube video not found', { videoId });
      return null;
    }
    
    const video = items[0];
    const snippet = video.snippet;
    const contentDetails = video.contentDetails;
    const statistics = video.statistics || {};
    const parsedViewCount = parseInt(statistics.viewCount || '0', 10);
    
    const meta: YouTubeMeta = {
      title: snippet.title,
      description: snippet.description || '',
      durationSec: parseDuration(contentDetails.duration),
      thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || '',
      channelTitle: snippet.channelTitle,
      publishedAt: snippet.publishedAt,
      viewCount: Number.isFinite(parsedViewCount) ? parsedViewCount : 0,
      tags: Array.isArray(snippet.tags) ? snippet.tags : []
    };
    
    logger.info('Fetched YouTube metadata', {
      videoId,
      title: meta.title,
      durationSec: meta.durationSec,
      viewCount: meta.viewCount,
    });
    
    return meta;
  } catch (error: any) {
    logger.error('Failed to fetch YouTube metadata', { 
      videoId, 
      error: error.response?.data?.error?.message || error.message 
    });
    return null;
  }
}

// Extract YouTube video ID from various URL formats
export function extractYouTubeId(urlOrId: string): string | null {
  if (!urlOrId) return null;
  
  // Already a video ID (11 characters)
  if (/^[a-zA-Z0-9_-]{11}$/.test(urlOrId)) {
    return urlOrId;
  }
  
  // Try to extract from URL
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/
  ];
  
  for (const pattern of patterns) {
    const match = urlOrId.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

// Enqueue a job to fetch YouTube metadata for a lecture
export function enqueueYouTubeMetaJob(
  videoId: string,
  courseId: string,
  moduleIndex: number,
  lectureIndex: number
): string {
  const payload: YouTubeMetaJobPayload = {
    videoId,
    courseId,
    moduleIndex,
    lectureIndex
  };
  
  return enqueue('youtube_meta_fetch', payload);
}

// Job handler for YouTube meta fetch
async function handleYouTubeMetaJob(payload: YouTubeMetaJobPayload): Promise<void> {
  const { videoId, courseId, moduleIndex, lectureIndex } = payload;
  
  const meta = await fetchYouTubeMeta(videoId);
  if (!meta) {
    throw new Error(`Failed to fetch metadata for video ${videoId}`);
  }
  
  // Update the course with the fetched metadata
  const updatePath = `syllabus.${moduleIndex}.lectures.${lectureIndex}.youtubeMeta`;
  
  const result = await Course.findByIdAndUpdate(
    courseId,
    {
      $set: {
        [updatePath]: {
          durationSec: meta.durationSec,
          thumbnail: meta.thumbnail,
          title: meta.title,
          fetchedAt: new Date()
        },
        [`syllabus.${moduleIndex}.lectures.${lectureIndex}.duration`]: Math.ceil(meta.durationSec / 60)
      }
    },
    { new: true }
  );
  
  if (!result) {
    throw new Error(`Course ${courseId} not found`);
  }
  
  logger.info('Updated course with YouTube metadata', { 
    courseId, 
    moduleIndex, 
    lectureIndex,
    title: meta.title 
  });
}

// Register the job handler on module load
registerJobHandler('youtube_meta_fetch', handleYouTubeMetaJob);

export default {
  fetchYouTubeMeta,
  extractYouTubeId,
  enqueueYouTubeMetaJob,
  extractPlaylistId,
  fetchPlaylistMeta,
  fetchPlaylistVideos,
};
