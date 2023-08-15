import { lstat, readdir, utimes } from 'fs/promises';
import { join as pathJoin } from 'path';
import { monitorProcess, spawn } from './process-util';
import { compareCaseSecondary, compareDottedValues, isAllUppercaseWords, toInt, toMixedCase, toNumber } from '@tubular/util';
import { abs, floor, round } from '@tubular/math';
import { code2Name, lang3to2 } from './lang';

const src = '/Volumes/video';
const CAN_MODIFY = true;
const CAN_MODIFY_TIMES = true;
const NEW_STUFF = new Date('2022-01-01T00:00Z');
const OLD = new Date('2015-01-01T00:00Z');

interface Counts {
  other: number;
  videos: number;
}

interface MediaTrack {
  "@type": string;
  BitDepth?: string;
  Channels?: string;
  Channels_Original?: string;
  ChannelPositions?: string;
  ChannelPositions_Original?: string;
  ChannelLayout?: string;
  ChannelLayout_Original?: string;
  DisplayAspectRatio?: string;
  HDR_Format?: string;
}

interface MediaWrapper {
  media: {
    track: MediaTrack[];
  }
}

interface GeneralTrackProperties {
  codec_id: string;
  default_track: boolean;
  enabled_track: boolean;
  flag_commentary: boolean;
  flag_original: boolean;
  forced_track: boolean;
  language: string;
  language_ietf?: string;
  media?: MediaTrack;
  number: number;
  track_name?: string;
  type: string;
  uid: string;
}

interface AudioTrackProperties extends GeneralTrackProperties {
  audio_channels: number;
  flag_visual_impaired: boolean;
}

interface SubtitlesTrackProperties extends GeneralTrackProperties {
  flag_hearing_impaired: boolean;
}

interface VideoTrackProperties extends GeneralTrackProperties{
  display_dimensions: string;
  pixel_dimensions: string;
  stereo_mode?: number;
}

interface GeneralTrack {
  codec: string;
  id: number;
  properties: GeneralTrackProperties;
  type: string;
}

interface AudioTrack extends GeneralTrack {
  properties: AudioTrackProperties;
}

interface SubtitlesTrack extends GeneralTrack {
  properties: SubtitlesTrackProperties;
}

interface VideoTrack extends GeneralTrack {
  properties: VideoTrackProperties;
}

type Track = AudioTrack | SubtitlesTrack | VideoTrack;

interface MKVInfo {
  chapters?: [{ num_entries: number }];
  container: {
    properties: {
      date_local?: string;
      date_utc?: string;
      duration: number;
      title?: string;
      writing_application?: string;
    }
  };
  tracks: Track[];
}

function formatTime(nanos: number): string {
  let secs = round(nanos / 10_000_000 + 0.5) / 100;
  const hours = floor(secs / 3600);
  secs -= hours * 3600;
  const minutes = floor(secs / 60);
  secs -= minutes * 60;

  return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`;
}

function formatAspectRatio(track: VideoTrackProperties): string {
  let ratio: number;

  if (track.media?.DisplayAspectRatio)
    ratio = toNumber(track.media?.DisplayAspectRatio);
  else {
    const [w, h] = track.display_dimensions.split('x').map(d => toInt(d));

    ratio = w / h;
  }

  if (abs(ratio - 1.33) < 0.02)
    return '4:3';
  else if (abs(ratio - 1.78) < 0.02)
    return '16:9';
  else if (abs(ratio - 1.85) < 0.02)
    return 'Wide';
  else
    return ratio.toFixed(2) + ':1';
}

function formatResolution(dims: string): string {
  const [w, h] = dims.split('x').map(d => toInt(d));

  if (w >= 2000 || h >= 1100)
    return 'UHD';
  else if (w >= 1300 || h >= 700)
    return 'Full HD';
  else if (w >= 750 || h >= 500)
    return 'HD';
  else
    return 'SD'
}

function channelString(track: AudioTrackProperties): string {
  let channels = track.audio_channels;
  let sub = (!track.media && channels > 4) ||
    /\bLFE\b/.test(track.media?.ChannelLayout) || /\bLFE\b/.test(track.media?.ChannelPositions) ||
    /\bLFE\b/.test(track.media?.ChannelLayout_Original) || /\bLFE\b/.test(track.media?.ChannelPositions_Original);

  if (channels === 1 && !sub)
    return 'Mono';
  else if (channels === 2 && !sub)
    return 'Stereo';
  else if (!sub)
    return channels + '.0';
  else
    return (channels - 1) + '.1';
}

function createTitle(title: string, name: string): string {
  if (title && !isAllUppercaseWords(title) && !/ (A|The|Of|From|For|And|Or) /.test(title) &&
    !/\b(DISC (\d|i)|3D|BLU-RAY|ULTRA HD)/i.test(title) && !/(\bMARVEL|:UE)/.test(title))
    return '';

  let newTitle = name.replace(/\.\w+$/, '').replace(/\s*\((2D|2K|3D|4K)\)/g, '').replace(/^\d{1,2}\s+-\s+/, '');

  if (!/:/.test(newTitle))
    newTitle = newTitle.replace(/\s+-\s+/g, ': ');

  return (newTitle !== title ? newTitle : '');
}

function getLanguage(props: GeneralTrackProperties): string {
  let lang = (props.language_ietf !== 'und' && props.language_ietf) || props.language || props.language_ietf;

  if (lang !== 'und' && lang?.length > 2)
    lang = lang3to2[lang] ?? lang;

  return lang;
}

function getCodec(track: GeneralTrack): string {
  let codec = track.codec || '';

  if (codec === 'DTS-HD Master Audio')
    codec = 'DTS-HD MA';
  else if (codec === 'AC-3 Dolby Surround EX')
    codec = 'DD EX';
  else if (codec === 'E-AC-3')
    codec = 'E-AC3';
  else if (/\bH.264\b/.test(codec))
    codec = 'H.264';
  else if (/\bH.265\b/.test(codec))
    codec = 'H.265';
  else if (codec === 'SubStationAlpha')
    codec = 'SSA';
  else if (/\bPGS\b/.test(codec))
    codec = 'PGS';

  if (track.properties?.media && track.properties.media['@type'] === 'Video') {
    const media = track.properties.media;

    if (toInt(media.BitDepth) > 8)
      codec += ' ' + media.BitDepth + '-bit';

    if (media.HDR_Format)
      codec += ' HDR';
  }

  return codec;
}

function trackFlags(props: GeneralTrackProperties): string
{
  let f = '';

  if (props.flag_original)
    f += 'O';

  if (props.flag_commentary)
    f += 'C';

  if ((props as SubtitlesTrackProperties).flag_hearing_impaired)
    f += 'H';

  if ((props as AudioTrackProperties).flag_visual_impaired)
    f += 'V';

  if (f)
    return ' <' + f + '>';

  return '';
}

function escapeArg(s: string): string {
  if (/[ "\\]/.test(s))
    s = '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

  return s;
}

const audioNames = new Set<string>();
const subtitlesNames = new Set<string>();
let updated = 0;

(async function() {
  async function checkDir(dir: string, depth = 0): Promise<Counts> {
    const files = (await readdir(dir)).sort(compareCaseSecondary);
    let videos = 0;
    let other = 0;

    for (let file of files) {
      const path = pathJoin(dir, file);
      let stat = await lstat(path);

      if (file.startsWith('.') || file.endsWith('~') || stat.isSymbolicLink())
        {}
      else if (stat.isDirectory()) {
        if (file.includes('§') || file === '-Extras-')
          {}
        else {
          const counts = await checkDir(path, depth + 1);

          other += counts.other;
          videos += counts.videos;
        }
      }
      else if (/\.(mkv|mv4|mov)$/i) {
        ++videos;
        console.log('file:', file);

        if (!file.endsWith('.mkv')) {
          console.log('    *** NOT MKV - skipping ***\n');
          continue;
        }

        const editArgs = [path];

        try {
          const mkvJson = (await monitorProcess(spawn('mkvmerge', ['-J', path])))
             // uid values exceed available numeric precision. Turn into strings instead.
            .replace(/("uid":\s+)(\d+)/g, '$1"$2"');
          const mkvInfo = JSON.parse(mkvJson) as MKVInfo;
          const video = mkvInfo.tracks.filter(t => t.type === 'video') as VideoTrack[];
          const audio = mkvInfo.tracks.filter(t => t.type === 'audio') as AudioTrack[];

          try {
            const mediaJson = (await monitorProcess(spawn('mediainfo', [path, '--Output=JSON'])));
            const mediaTracks = (JSON.parse(mediaJson) as MediaWrapper).media.track;
            const typeIndices = {} as Record<string, number>;

            for (const track of mediaTracks) {
              const type = track['@type'].toLowerCase();
              const index = (typeIndices[type] ?? -1) + 1;
              const mkvSet = (type === 'video' ? video : type === 'audio' ? audio : []);

              typeIndices[type] = index;

              if (mkvSet[index]?.properties)
                mkvSet[index].properties.media = track;
            }
          }
          catch (e) {
            console.warn('No mediainfo:', e.message);
          }

          const chapters = (mkvInfo.chapters || [])[0]?.num_entries || 0;
          const duration = formatTime(mkvInfo.container.properties.duration);
          const cp = mkvInfo.container.properties;
          const title = cp.title;
          const app = cp.writing_application;
          let origDate = (cp.date_utc || cp.date_local) && new Date(cp.date_utc || cp.date_local);
          const suggestedTitle = createTitle(title, file);
          const subtitles = mkvInfo.tracks.filter(t => t.type === 'subtitles') as SubtitlesTrack[];
          const aspect = formatAspectRatio(video[0].properties);
          const resolution = formatResolution(video[0].properties.pixel_dimensions);
          const codec = getCodec(video[0]);
          const d3 = (video[0].properties.stereo_mode ? ' (3D)' : '')

          if (/^HandBrake/.test(app)) {
            const version = (/^HandBrake\s+(\d+\.\d+)/.exec(app) ?? [])[1];
            const lowVersion = (compareDottedValues(version, '1.0') < 0);
            const $ = /\b(\d\d\d\d)(\d\d)(\d\d)(\d\d)?$/.exec(app);
            let date: Date;

            if ($)
              date = new Date(`${$[1]}-${$[2]}-${$[3]}T00:00Z`);

            if (date && (!origDate || lowVersion))
              origDate = date;
            else if (lowVersion)
              origDate = OLD;
          }

          if (suggestedTitle)
            editArgs.push('--edit', 'info', '--set', 'title=' + suggestedTitle);

          console.log('            Title:', (title || '(untitled)') + (suggestedTitle ? ' --> ' + suggestedTitle : ''));
          console.log('         Duration:', duration + (chapters ? ', ' + chapters + ' chapters' : ''));
          console.log('            Video:', video.length < 1 ? 'NONE' :
            `${codec} ${resolution}, ${aspect}${d3}` +
            (video.length > 1 ? `, plus ${video.length - 1} other track${video.length > 2 ? 's' : ''}` : ''));

          let primaryLang = '';

          if (audio.length > 0) {
            const defaultTrack = audio.find(t => t.properties.default_track) ?? audio[0];
            const languages = new Set<string>();

            primaryLang = getLanguage(defaultTrack.properties);

            for (const track of audio)
              languages.add(getLanguage(track.properties));

            for (const track of subtitles)
              languages.add(getLanguage(track.properties));

            const langCount = languages.size;

            for (let i = 1; i <= audio.length; ++i) {
              const track = audio[i - 1];
              const tp = track.properties;
              const lang = getLanguage(tp);
              const language = code2Name[lang];
              let name = tp.track_name || '';
              const pl2 = /dolby pl2/i.test(name);
              const codec = getCodec(track);
              const channels = (tp.audio_channels === 2 && pl2) ? 'Dolby PL2' : channelString(tp);
              let da = /\bda(\s+([0-9.]+|stereo|mono))?$/i.test(name);
              let newName = '';
              let audioDescr = `:${codec}: ${channels}`;

              if (!da && tp.flag_visual_impaired)
                da = true;

              if (language && (langCount > 1 || da))
                audioDescr = language + ' ' + audioDescr;

              const $ = /(^Commentary[^(]*)(\(\S+\s+\S+\))$/.exec(name);

              if ($)
                newName = $[1].trim();

              if (da && language)
                newName = `${language} DA${tp.audio_channels !== 2 ? ' ' + channels : ''}`;
              else if (name && /instrumental|music|score|original/i.test(name)) {
                if (!/\(|\b([0-9.]+|stereo|mono)\b/i.test(name)) {
                  if (codec === 'AC-3')
                    newName = `${toMixedCase(name).trim()} ${channels}`;
                  else
                    newName = `${toMixedCase(name).trim()} (${codec} ${channels})`;
                }
              }
              else if (name && !/commentary|cd audio|ld audio|restored/i.test(name)) {
                if (primaryLang && (lang === primaryLang || !lang || !language))
                  newName = audioDescr.replace(/:/g, '');
                else
                  newName = audioDescr.replace(/:[^:]*: /g, '');
              }

              newName = newName.replace('MP3 Dolby', 'Dolby').replace(/\s+AC-3\b/, '');
              audioDescr = audioDescr.replace(/:/g, '');

              if (!name && !newName)
                newName = audioDescr;

              if (!tp.flag_commentary && /commentary/i.test(name)) {
                editArgs.push('--edit', 'track:a' + i, '--set', 'flag-commentary=1');
                tp.flag_commentary = true;
              }

              if (!tp.flag_visual_impaired && da) {
                editArgs.push('--edit', 'track:a' + i, '--set', 'flag-visual-impaired=1');
                tp.flag_visual_impaired = true;
              }

              if (!tp.flag_original && primaryLang === 'en' && lang === 'en') {
                editArgs.push('--edit', 'track:a' + i, '--set', 'flag-original=1');
                tp.flag_original = true;
              }

              if (newName && name !== newName) {
                name = newName;
                editArgs.push('--edit', 'track:a' + i, '--set', 'name=' + name);
              }

              audioNames.add(lang + ':' + (name ? name : ''));
              audioDescr = ((name ? name : '(unnamed)' ) + (audioDescr !== name ? ` [${audioDescr}]` : '')).trim();

              console.log(`         ${i < 10 ? ' ' : ''}Audio ${i}: ${audioDescr}` +
                (track === defaultTrack ? ' (primary audio)' : '') + trackFlags(tp));
            }
          }
          else
            console.log('            Audio: NONE');

          if (subtitles.length > 0) {
            const defaultTrack = subtitles.find(t => t.properties.default_track) ??
                    subtitles.find(t => t.properties.forced_track);

            for (let i = 1; i <= subtitles.length; ++i) {
              const track = subtitles[i - 1];
              const tp = track.properties;
              const name = tp.track_name;
              const lang = getLanguage(tp);
              const codec = getCodec(track);
              const descr = (codec + ' ' + (lang ? lang : '??') + ', ' + (name ? name : '(unnamed)')).trim();

              subtitlesNames.add(lang + ':' + (tp.track_name ? tp.track_name : ''));

              if (!tp.flag_commentary && /commentary/i.test(tp.track_name)) {
                editArgs.push('--edit', 'track:s' + i, '--set', 'flag-commentary=1');
                tp.flag_commentary = true;
              }

              if (tp.track_name?.toLowerCase() === 'description' && lang === 'en') {
                editArgs.push('--edit', 'track:s' + i, '--set', 'name=English SDH');
                tp.track_name = "English SDH";
              }

              if (!tp.flag_hearing_impaired && /\bsdh$/i.test(tp.track_name)) {
                editArgs.push('--edit', 'track:s' + i, '--set', 'flag-hearing-impaired=1');
                tp.flag_hearing_impaired = true;
              }

              // If flag_original is *explicitly* false, rather than just not set, don't change it.
              if (!tp.flag_original && primaryLang === 'en' && lang === 'en' && tp.flag_original !== false) {
                editArgs.push('--edit', 'track:s' + i, '--set', 'flag-original=1');
                tp.flag_original = true;
              }

              if (lang?.length === 2 && tp.track_name?.length === 2 && tp.track_name !== lang)
                editArgs.push('--edit', 'track:s' + i, '--set', 'name=' + lang);

              console.log(`     ${i < 10 ? ' ' : ''}Subtitles ${i}: ${descr}` +
                (track === defaultTrack ? ' (forced)' : '') + trackFlags(tp));
            }
          }

          if (editArgs.length > 1) {
            try {
              if (CAN_MODIFY) {
                await monitorProcess(spawn('mkvpropedit', editArgs));
                console.log('    *** Update succeeded');
              }

              ++updated;
              console.log('    *** Update: ', editArgs.splice(1).map(s => escapeArg(s)).join(' '));
            }
            catch (e) {
              console.error('    *** UPDATE FAILED: ' + e.message);
            }
          }

          if (CAN_MODIFY && CAN_MODIFY_TIMES && origDate && origDate.getTime() < NEW_STUFF.getTime()) {
            try {
              stat = await lstat(path);
              await utimes(path, stat.atime, origDate);
            }
            catch {}
          }

          console.log();
        }
        catch (e) {
          console.error(e);
        }
      }
      else {
        ++other;
        console.log('other:', file);
      }
    }

    return { other, videos };
  }

  const counts = await checkDir(src);

  console.log('\nVideo count:', counts.videos);
  console.log('Other count:', counts.other);
  console.log('Updated:', updated);
  console.log('\nUnique audio track names:\n ', Array.from(audioNames).sort(compareCaseSecondary).join('\n  '));
  console.log('\nUnique subtitles track names:\n ', Array.from(subtitlesNames).sort(compareCaseSecondary).join('\n  '));
})();
