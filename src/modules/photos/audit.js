export const approvedMedia = (media) => media.approval?.status === 'approved';
export const supportedPhoto = (media) => media.mediaType !== 'video' && !media.mimeType?.startsWith('video/');

export function mediaAudit(media, services, now = new Date()) {
  const approved = media.filter(approvedMedia);
  return {
    total: media.length, approved: approved.length, pending: media.filter((m) => !m.approval || m.approval.status === 'pending').length,
    photos: media.filter(supportedPhoto).length, videos: media.filter((m) => !supportedPhoto(m)).length,
    published: media.filter((m) => m.google?.syncStatus === 'synced').length,
    failed: media.filter((m) => m.google?.syncStatus === 'failed').length,
    categoryGaps: ['exterior', 'interior', 'team', 'services'].filter((category) => !approved.some((m) => m.category === category)),
    serviceGaps: services.filter((s) => !approved.some((m) => m.services?.some((id) => String(id) === String(s._id)))).map((s) => ({ id: s._id, name: s.name })),
    older: approved.filter((m) => now - new Date(m.capturedAt || m.createdAt) > 180 * 864e5).length,
    lowResolution: media.filter((m) => supportedPhoto(m) && m.width && m.height && Math.min(m.width, m.height) < 720).length,
    missingDimensions: media.filter((m) => supportedPhoto(m) && (!m.width || !m.height)).length,
    performanceAvailable: media.some((m) => m.google?.viewCount != null),
    performanceNote: 'Google views are displayed only when returned by its media API. No ranking or revenue attribution is inferred.',
  };
}
