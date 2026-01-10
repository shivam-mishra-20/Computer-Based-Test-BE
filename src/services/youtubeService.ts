// YouTube Data API service for fetching video metadata
// Uses YouTube Data API v3

import axios from 'axios';
import { logger } from '../utils/logger';
import { enqueue, registerJobHandler, YouTubeMetaJobPayload } from './jobQueue';
import Course from '../models/Course';

const YOUTUBE_API_KEY = process.env.YOUTUBE_DATA_API;
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

export interface YouTubeMeta {
  title: string;
  description: string;
  durationSec: number;
  thumbnail: string;
  channelTitle: string;
  publishedAt: string;
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
        part: 'snippet,contentDetails',
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
    
    const meta: YouTubeMeta = {
      title: snippet.title,
      description: snippet.description?.substring(0, 500) || '',
      durationSec: parseDuration(contentDetails.duration),
      thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || '',
      channelTitle: snippet.channelTitle,
      publishedAt: snippet.publishedAt
    };
    
    logger.info('Fetched YouTube metadata', { videoId, title: meta.title, durationSec: meta.durationSec });
    
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
  enqueueYouTubeMetaJob
};
