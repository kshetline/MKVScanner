import { Stats } from 'fs';
import { lstat, mkdtemp, readdir, rename, unlink, utimes } from 'fs/promises';
import { join as pathJoin, sep as pathSeparator } from 'path';
import { ErrorMode, monitorProcess, spawn } from './process-util';
import {
  compareDottedValues, isAllUppercaseWords, last, toInt, toMixedCase, toNumber
} from '@tubular/util';
import { abs, floor, min, round } from '@tubular/math';
import { code2Name, lang2to3, lang3to2 } from './lang';
import * as os from 'os';

const isWindows = (os.platform() === 'win32');
const src = (isWindows ? 'V:' : '/Volumes/video');
const CAN_MODIFY = true;
const CAN_MODIFY_TIMES = true;
const SKIP_MOVIES = false;
const SKIP_TV = false;
const SKIP_EXTRAS = false;
const SHOW_DETAILS = true;
const UPDATE_EXTRAS_METADATA = false;
const CREATE_ALTERNATE_AUDIO = true;

const NEW_STUFF = new Date('2022-01-01T00:00Z');
const OLD = new Date('2015-01-01T00:00Z');

interface Counts {
  other: number;
  videos: number;
}

interface MediaTrack {
  '@type': string;
  BitDepth?: string;
  Channels?: string;
  Channels_Original?: string;
  ChannelPositions?: string;
  ChannelPositions_Original?: string;
  ChannelLayout?: string;
  ChannelLayout_Original?: string;
  CodecID?: string;
  Encoded_Library?: string;
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
  if (!track)
    return '';

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
  if (!dims)
    return '';

  const [w, h] = dims.split('x').map(d => toInt(d));

  if (w >= 2000 || h >= 1100)
    return 'UHD';
  else if (w >= 1300 || h >= 700)
    return 'FHD';
  else if (w >= 750 || h >= 500)
    return 'HD';
  else
    return 'SD';
}

function channelString(track: AudioTrackProperties): string {
  // The code below is a bit iffy. It's working for me for now, but there's some stuff I don't
  // fully understand about channel info, particularly how the `XXX_Original` variants are
  // supposed to work. No answers from the mediainfo forum yet!
  const channels = track.audio_channels;
  const sub = (!track.media && channels > 4) ||
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

  let newTitle = toNonFileName(name.replace(/\.\w+$/, '').replace(/\s*\((2D|2K|3D|4K)\)/g, '').replace(/^\d{1,2}\s+-\s+/, ''));

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
  if (!track)
    return '';

  let codec = track.codec || '';

  if (codec === 'DTS-HD Master Audio')
    codec = 'DTS-HD MA';
  else if (codec === 'DTS-HD High Resolution Audio')
    codec = 'DTS-HD HRA';
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

function trackFlags(props: GeneralTrackProperties): string {
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

function toNonFileName(s: string): string {
  return s.replace(/：/g, ':').replace(/？/g, '?').replace(/．/g, '.').replace(/([a-z])'([a-z])/gi, '$1’$2');
}

function normalizeTitle(s: string): string {
  return s.replace(/\s+\([^(]*\b(cut|edition|version)\)/i, '');
}

async function safeUnlink(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  }
  catch (e) {
    if (e.code !== 'ENOENT')
      throw e;
  }

  return false;
}

async function safeLstat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  }
  catch (e) {
    if (e.code !== 'ENOENT')
      throw e;
  }

  return null;
}

async function existsAsync(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  }
  catch (e) {
    if (e.code !== 'ENOENT')
      throw e;
  }

  return false;
}

async function updateAudioTracks(path: string, videoCount: number,
                                 aacTrack: number | null, aacTrackName: string, lang: string,
                                 mp3Track: number, mainChannels: number): Promise<void> {
  try {
    let aacFile = '';

    if (aacTrack > 0) {
      const args = ['-i', path, '-map', '0:1', '-c', 'aac', '-ac', min(mainChannels, 2).toString(),
                    '-b:a', mainChannels < 2 ? '96k' : '192k'];
      let duration = -1;
      let lastPercent = -1;
      let percentStr = '';
      const aacProgress = (data: string, stream: number): void => {
        if (stream === 1) {
          let $: RegExpExecArray;

          if (duration < 1 && ($ = /\bDURATION\b\s*:\s*(\d\d):(\d\d):(\d\d)/.exec(data)))
            duration = toInt($[1]) * 3600 + toInt($[2]) * 60 + toInt($[3]);

          if (duration > 0 && ($ = /.*\btime=(\d\d):(\d\d):(\d\d)/.exec(data))) {
            const elapsed = toInt($[1]) * 3600 + toInt($[2]) * 60 + toInt($[3]);
            const percent = round(elapsed * 100 / duration);

            if (lastPercent !== percent) {
              lastPercent = percent;

              if (percentStr)
                process.stdout.write('%\x1B[' + (percentStr.length + 1) + 'D');

              percentStr = percent + '%';
              process.stdout.write(percentStr + '\x1B[K');
            }
          }
        }
      };

      aacFile = pathJoin(os.tmpdir(), await mkdtemp('tmp-') + '.tmp.aac');

      if (mainChannels > 3)
        args.push('-af', 'aresample=matrix_encoding=dplii');

      args.push('-ar', '44100', aacFile);
      process.stdout.write('    Generating AAC track... ');
      await safeUnlink(aacFile);
      await monitorProcess(spawn('ffmpeg', args), aacProgress, ErrorMode.DEFAULT, 4096);
      console.log();
    }

    process.stdout.write('    Remuxing... ');

    const backupPath = path.replace(/\.mkv$/i, '[zni].bak.mkv');
    const updatePath = path.replace(/\.mkv$/i, '[zni].upd.mkv');
    const args2 = ['-o', updatePath, path];

    if (mp3Track > 0)
      args2.splice(2, 0, '--atracks', '!' + mp3Track);

    if (aacFile) {
      let tracks = '';

      for (let i = 0; i < videoCount + aacTrack - (mp3Track > 0 && mp3Track <= aacTrack ? 0 : 1); ++i)
        tracks += '0:' + i + ',';

      args2.push('--original-flag', '0', '--track-name', '0:' + aacTrackName,
        '--language', '0:' + (lang2to3[lang] || lang || 'und'),
        aacFile, '--track-order', tracks + '1:0');
    }

    let percentStr = '';
    const mergeProgress = (data: string, stream: number): void => {
      let $: RegExpExecArray;

      if (stream === 0 && ($ = /\bProgress: (\d{1,3}%)/.exec(data)) && percentStr !== $[1]) {
        if (percentStr)
          process.stdout.write('%\x1B[' + (percentStr.length + 1) + 'D');

        percentStr = $[1];
        process.stdout.write(percentStr + '\x1B[K');
      }
    };

    await safeUnlink(updatePath);
    await monitorProcess(spawn('mkvmerge', args2), mergeProgress, ErrorMode.DEFAULT, 4096);
    console.log();

    if (!isWindows)
      await monitorProcess(spawn('chmod', ['--reference=' + backupPath, path]));

    await rename(path, backupPath);
    await rename(updatePath, path);

    if (CAN_MODIFY_TIMES) {
      const stat = await lstat(backupPath);
      const newTime = new Date(stat.mtime.getTime() + 60000);

      await utimes(path, newTime, newTime);
    }

    await unlink(backupPath);

    if (aacFile)
      await safeUnlink(aacFile);
  }
  catch (e) {
    console.error(e);
  }
}

const comparator = new Intl.Collator('en', { caseFirst: 'upper' }).compare;
const audioNames = new Set<string>();
const subtitlesNames = new Set<string>();
const movieTitles = new Set<string>();
const tvTitles = new Set<string>();
const tvEpisodes = new Set<string>();
let updated = 0;
let updatedAudio = 0;
let hasUnnamedSubtitleTracks = 0;
let legacyRips = 0;
let extras = 0;
let extrasStorage = 0;
let movies = 0;
let movieStorage = 0;
let tvShows = 0;
let tvStorage = 0;
let errorCount = 0;

(async function (): Promise<void> {
  async function checkDir(dir: string, depth = 0): Promise<Counts> {
    const files = (await readdir(dir)).sort(comparator);
    let videos = 0;
    let other = 0;

    for (let file of files) {
      let path = pathJoin(dir, file);
      const stat = await safeLstat(path);

      if (!stat || file.startsWith('.') || file.endsWith('~') || file.includes(' ~.') || stat.isSymbolicLink()) {
        // Do nothing
      }
      else if (stat.isDirectory()) {
        if (file === 'Home movies')
          continue;

        const counts = await checkDir(path, depth + 1);

        other += counts.other;
        videos += counts.videos;
      }
      else if (/\.(mkv|mv4|mov)$/i.test(file) && !/(\[zni]|(\.tmp\.)|(\.bak\.))/.test(file)) {
        ++videos;
        console.log('file: %s (%s)', file, dir);

        if (file.endsWith('.upd.mkv')) {
          const baseFile = file.replace(/(\[[^]]*])?\.upd\.mkv$/, '.mkv');

          if (!await existsAsync(baseFile)) {
            const newPath = pathJoin(dir, baseFile);

            await rename(path, newPath);
            path = newPath;
            file = baseFile;
            console.log('    *** Recovering original file from update file');
          }
          else {
            await safeUnlink(path);
            console.log('    *** Deleting leftover work file');
            continue;
          }
        }

        if (!file.endsWith('.mkv')) {
          console.log('    *** NOT MKV - skipping ***\n');
          continue;
        }

        let isExtra = false;
        let isMovie = false;
        let isTV = false;

        if (/[\\/](-Extras-|.*Bonus Disc.*)[\\/]/i.test(path)) {
          isExtra = true;
          ++extras;
          extrasStorage += stat.size;
        }
        else if (/§/.test(path) && !/[\\/]Movies[\\/]/.test(path)) {
          isTV = true;
          ++tvShows;
          tvStorage += stat.size;
        }
        else {
          isMovie = true;
          ++movies;
          movieStorage += stat.size;
        }

        if (isMovie && SKIP_MOVIES || isTV && SKIP_TV || isExtra && SKIP_EXTRAS)
          continue;

        let newFileName = '';
        let newTitle = '';

        if (isTV) {
          const seriesTitle = last(path.replace(/^\w:/, '').split(pathSeparator).filter(s => s.includes('§')).map(s => s.trim()
            .replace(/^\d+\s*-\s*/, '')
            .replace(/§.*$/, '')
            .replace(/\s+-\s+\d\d\s+-\s+/, ': ')
            .replace(/\s+-\s+/, ': ')
            .replace(/\s*\((TV|SD|4K|(\d*\s*TV series|Joseph Campbell|BBC Earth))\)/g, '').trim()
            .replace(/(.+), The$/, 'The $1')));

          if (!seriesTitle) {
            console.warn('    *** Failed to extract TV series title');
            tvTitles.add('Unknown title for: ' + path);
          }
          else {
            tvTitles.add(seriesTitle);

            let $ = /\s*-\s*(S(\d{1,2}))?(E(\d{1,2})(?:&\d\d)?)\s*-\s*(.+)(\.\w{2,4})$/.exec(file);
            let gotEpisode = false;

            if (!$) {
              $ = /^(\D?)(\d{1,2})(?:\s*-\s*)(.+)(\.\w{2,4})$/.exec(file);

              if ($) {
                gotEpisode = true;
                $.splice(0, 1, '', '', '');
              }
              else
                console.warn('    *** Failed to extract TV episode');
            }

            if (gotEpisode) {
              const safeSeriesTitle = seriesTitle.replace(/[^-.!'"_()[\]0-9A-Za-z\u00FF-\uFFFF]/g, ' ')
                .replace(/\s+/g, ' ').replace('(Brett)', '(1984)').trim();
              const season = toInt($[2] || '1');
              const episode = toInt($[4]);
              const episodeTitle = $[5];
              const restoredTitle = toNonFileName(episodeTitle);
              const ext = $[6];
              const se = `S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`;

              newFileName = `${safeSeriesTitle} - ${se} - ${episodeTitle}${ext}`;
              newTitle = `${seriesTitle} • ${se} • ${restoredTitle}`;
              tvEpisodes.add(`${safeSeriesTitle}•${se}`);

              console.log(newFileName);
              console.log(newTitle);
            }
          }
        }

        const editArgs = [path];

        try {
          const mkvJson = (await monitorProcess(spawn('mkvmerge', ['-J', path])))
          // uid values exceed available numeric precision. Turn into strings instead.
            .replace(/("uid":\s+)(\d+)/g, '$1"$2"');
          const mkvInfo = JSON.parse(mkvJson) as MKVInfo;

          const video = mkvInfo.tracks.filter(t => t.type === 'video') as VideoTrack[];
          const audio = mkvInfo.tracks.filter(t => t.type === 'audio') as AudioTrack[];
          let aacTrack: number | null = -1;
          let newAAC = -2;
          let mp3Track = -1;
          let mp3Name = '';
          let mainChannels = 0;
          const mediaJson = await monitorProcess(spawn('mediainfo', [path, '--Output=JSON']));
          const mediaTracks = (JSON.parse(mediaJson || '{}') as MediaWrapper).media?.track || [];
          const typeIndices = {} as Record<string, number>;

          for (const track of mediaTracks) {
            const type = track['@type'].toLowerCase();
            const index = (typeIndices[type] ?? -1) + 1;
            const mkvSet = (type === 'video' ? video : type === 'audio' ? audio : []);

            typeIndices[type] = index;

            if (mkvSet[index]?.properties)
              mkvSet[index].properties.media = track;
          }

          const chapters = (mkvInfo.chapters || [])[0]?.num_entries || 0;
          const duration = formatTime(mkvInfo.container.properties.duration);
          const cp = mkvInfo.container.properties;
          const title = cp.title;
          const app = cp.writing_application;
          let origDate = (cp.date_utc || cp.date_local) && new Date(cp.date_utc || cp.date_local);
          let suggestedTitle = newTitle || createTitle(title, file);
          const subtitles = mkvInfo.tracks.filter(t => t.type === 'subtitles') as SubtitlesTrack[];
          const aspect = formatAspectRatio(video[0]?.properties);
          const resolution = formatResolution(video[0]?.properties?.pixel_dimensions);
          const is4K = (resolution === 'UHD');
          const codec = getCodec(video[0]);
          const is3D = !!video[0]?.properties.stereo_mode;
          const d3 = (is3D ? ' (3D)' : '');

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

          if (!origDate || stat.mtimeMs < NEW_STUFF.getTime())
            origDate = stat.mtime;

          if ((suggestedTitle || title) && isMovie)
            movieTitles.add(normalizeTitle(suggestedTitle || title));

          if (isExtra && !UPDATE_EXTRAS_METADATA)
            suggestedTitle = undefined;
          else if (suggestedTitle && suggestedTitle !== title && !/[:?•’]/.test(title))
            editArgs.push('--edit', 'info', '--set', 'title=' + suggestedTitle);
          else
            suggestedTitle = undefined;

          if (SHOW_DETAILS) {
            console.log('            Title:', (title || '(untitled)') + (suggestedTitle ? ' --> ' + suggestedTitle : ''));
            console.log('         Duration:', duration + (chapters ? ', ' + chapters + ' chapters' : ''));
            console.log('            Video:', video.length < 1 ? 'NONE' :
              `${codec} ${resolution}, ${aspect}${d3}` +
              (video.length > 1 ? `, plus ${video.length - 1} other video track${video.length > 2 ? 's' : ''}` : ''));
          }

          let primaryLang = '';
          let langCount = 0;

          if (audio.length > 0) {
            const defaultTrack = audio.find(t => t.properties.default_track) ?? audio[0];
            const languages = new Set<string>();

            primaryLang = getLanguage(defaultTrack.properties);

            for (const track of audio)
              languages.add(getLanguage(track.properties));

            for (const track of subtitles)
              languages.add(getLanguage(track.properties));

            langCount = languages.size;

            for (let i = 1; i <= audio.length; ++i) {
              const track = audio[i - 1];
              const tp = track.properties;
              const lang = getLanguage(tp);
              const language = code2Name[lang];
              let name = tp.track_name || '';
              const pl2 = /dolby pl(2|ii)/i.test(name);
              const codec = getCodec(track);
              const cCount = tp.audio_channels;
              const channels = (cCount === 2 && pl2) ? 'Dolby PL2' : channelString(tp);
              let da = /\bda(\s+([0-9.]+|stereo|mono))?$/i.test(name);
              let newName = '';
              let audioDescr = `:${codec}: ${channels}`;

              if (newAAC < 0 && i > 1 && (cCount <= 2 || lang !== primaryLang))
                newAAC = i;

              if (!da && tp.flag_visual_impaired)
                da = true;

              if (language && (langCount > 1 || da))
                audioDescr = language + ' ' + audioDescr;

              const $ = /(^Commentary[^(]*)(\(\S+\s+\S+\))$/.exec(name);

              if ($)
                newName = $[1].trim();

              if (da && language)
                newName = `${language} DA${cCount !== 2 ? ' ' + channels : ''}`;
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

              newName = newName.replace(/(AAC|MP3) (?=Dolby PL(2|ii))/i, '').replace(/\s+AC-3\b/, '');
              audioDescr = audioDescr.replace(/:/g, '');

              if (!name && !newName)
                newName = audioDescr;

              if (!tp.flag_commentary && /commentary/i.test(name)) {
                editArgs.push('--edit', 'track:a' + i, '--set', 'flag-commentary=1');
                tp.flag_commentary = true;
              }
              else if (tp.flag_commentary && !/commentary/i.test(name)) {
                editArgs.push('--edit', 'track:a' + i, '--set', 'flag-commentary=0');
                tp.flag_commentary = false;
              }

              if (!tp.flag_visual_impaired && da) {
                editArgs.push('--edit', 'track:a' + i, '--set', 'flag-visual-impaired=1');
                tp.flag_visual_impaired = true;
              }
              else if (tp.flag_visual_impaired && !da) {
                editArgs.push('--edit', 'track:a' + i, '--set', 'flag-visual-impaired=0');
                tp.flag_visual_impaired = false;
              }

              if (!tp.flag_original && primaryLang === 'en' && lang === 'en') {
                editArgs.push('--edit', 'track:a' + i, '--set', 'flag-original=1');
                tp.flag_original = true;
              }

              if (newName && name !== newName) {
                name = newName;
                editArgs.push('--edit', 'track:a' + i, '--set', 'name=' + name);
              }

              audioNames.add(lang + ':' + (name || ''));
              audioDescr = ((name || '(unnamed)') + (audioDescr !== name ? ` [${audioDescr}]` : '')).trim();

              if (i === 1)
                mainChannels = cCount;

              if (codec === 'AAC' && cCount <= 2 && lang === primaryLang && !/commentary/i.test(name))
                aacTrack = i;
              else if (codec === 'MP3') {
                mp3Track = i;
                mp3Name = name;
              }

              if (SHOW_DETAILS)
                console.log(`         ${i < 10 ? ' ' : ''}Audio ${i}: ${audioDescr}` +
                  (track === defaultTrack ? ' (primary audio)' : '') + trackFlags(tp));
            }
          }
          else if (SHOW_DETAILS)
            console.log('            Audio: NONE');

          if (subtitles.length > 0) {
            const defaultTrack = subtitles.find(t => t.properties.default_track) ??
              subtitles.find(t => t.properties.forced_track);

            let hasUnnamed = 0;

            for (let i = 1; i <= subtitles.length; ++i) {
              const track = subtitles[i - 1];
              const tp = track.properties;
              let name = tp.track_name;
              const lang = getLanguage(tp);
              const codec = getCodec(track);
              const baseDescr = (codec + ' ' + (lang || '??') + ', ').trimStart();

              subtitlesNames.add(lang + ':' + (tp.track_name ? tp.track_name : ''));

              if (!tp.flag_commentary && /commentary|info/i.test(tp.track_name)) {
                editArgs.push('--edit', 'track:s' + i, '--set', 'flag-commentary=1');
                tp.flag_commentary = true;
              }
              else if (tp.flag_commentary && !/commentary|info/i.test(tp.track_name)) {
                editArgs.push('--edit', 'track:s' + i, '--set', 'flag-commentary=0');
                tp.flag_commentary = false;
              }

              if (tp.track_name?.toLowerCase() === 'description' && lang === 'en') {
                editArgs.push('--edit', 'track:s' + i, '--set', 'name=English SDH');
                tp.track_name = 'English SDH';
              }

              if (!tp.flag_hearing_impaired && /\bSDH\b/.test(tp.track_name)) {
                editArgs.push('--edit', 'track:s' + i, '--set', 'flag-hearing-impaired=1');
                tp.flag_hearing_impaired = true;
              }
              else if (tp.flag_hearing_impaired && !/\bSDH\b/.test(tp.track_name)) {
                editArgs.push('--edit', 'track:s' + i, '--set', 'flag-hearing-impaired=0');
                tp.flag_hearing_impaired = false;
              }

              // If flag_original is *explicitly* false, rather than just not set, don't change it.
              if (!tp.flag_original && primaryLang === 'en' && lang === 'en' && tp.flag_original !== false) {
                editArgs.push('--edit', 'track:s' + i, '--set', 'flag-original=1');
                tp.flag_original = true;
              }

              if (lang?.length === 2 && tp.track_name?.length === 2 && tp.track_name !== lang) {
                editArgs.push('--edit', 'track:s' + i, '--set', 'name=' + lang);
                name = lang;
              }

              if (!name)
                hasUnnamed = 1;

              if (SHOW_DETAILS)
                console.log(`     ${i < 10 ? ' ' : ''}Subtitles ${i}: ${(baseDescr + (name || '(unnamed)')).trim()}` +
                  (track === defaultTrack ? ' (forced)' : '') + trackFlags(tp));
            }

            hasUnnamedSubtitleTracks += hasUnnamed;
          }

          const oldStuff = origDate && origDate.getTime() < NEW_STUFF.getTime();
          let wasUpdated = false;

          legacyRips += oldStuff ? 1 : 0;

          if (editArgs.length > 1 && (!isExtra || UPDATE_EXTRAS_METADATA)) {
            try {
              if (CAN_MODIFY) {
                await monitorProcess(spawn('mkvpropedit', editArgs), null, ErrorMode.FAIL_ON_ANY_ERROR);

                if (oldStuff && CAN_MODIFY_TIMES)
                  await utimes(path, stat.atime, new Date(origDate.getTime() + 60000));

                console.log('    *** Update succeeded');
              }

              wasUpdated = true;

              if (SHOW_DETAILS)
                console.log('    *** Update: ', editArgs.splice(1).map(s => escapeArg(s)).join(' '));
            }
            catch (e) {
              ++errorCount;
              console.error('    *** UPDATE FAILED: ' + e.message);
            }
          }

          if (mainChannels > 0 && !/Original Special Effects/i.test(path)) {
            let aacTrackName: string;

            aacTrack = (is3D || is4K ? (aacTrack < 0 ? null : -aacTrack) : (aacTrack < 0 ? abs(newAAC) : null));

            if (mp3Track >= 0)
              console.log('    Will remove MP3 track');

            if (aacTrack < 0)
              console.log('    Will remove unneeded AAC track');
            else if (aacTrack > 0) {
              if (mp3Name)
                aacTrackName = mp3Name.replace(/\bMP3\b/g, 'AAC');
              else {
                aacTrackName = (mainChannels > 3 ? 'Dolby PL2' : mainChannels > 1 ? 'AAC Stereo' : 'AAC Mono');

                if (primaryLang && langCount > 1)
                  aacTrackName = (code2Name[primaryLang] || primaryLang) + ' ' + aacTrackName;
              }

              console.log('    Will add new AAC track:', aacTrackName);
            }

            if (CAN_MODIFY && CREATE_ALTERNATE_AUDIO && (aacTrack != null || mp3Track >= 0)) {
              await updateAudioTracks(path, video.length, aacTrack, aacTrackName, primaryLang, mp3Track, mainChannels);
              wasUpdated = true;
              ++updatedAudio;
            }
          }

          if (CAN_MODIFY && newFileName && file !== newFileName) {
            try {
              await rename(path, pathJoin(dir, newFileName));
            }
            catch (e) {
              ++errorCount;
              console.error('    *** RENAME FAILED: ' + e.message);
            }
          }

          updated += (wasUpdated ? 1 : 0);
          console.log();
        }
        catch (e) {
          console.error(e);
        }
      }
      else {
        ++other;
        console.log('other:', file + '\n');
      }
    }

    return { other, videos };
  }

  const counts = await checkDir(src);

  console.log('\nVideo count:', counts.videos);
  console.log(`Movies (raw): ${movies}, TV episodes (raw): ${tvShows}, Extras: ${extras}`);
  console.log(`Movies (unique): ${movieTitles.size}, TV episodes (unique): ${tvEpisodes.size}`);
  console.log(`Movies: ${(movieStorage / 1E9).toFixed(2)}GB, TV: ${(tvStorage / 1E9).toFixed(2)}GB, Extras: ${(extrasStorage / 1E9).toFixed(2)}GB`);
  console.log('Other count:', counts.other);
  console.log('Updated:', updated);
  console.log('Updated audio:', updatedAudio);
  console.log('Legacy rips:', legacyRips);
  console.log('Has unnamed subtitle tracks:', hasUnnamedSubtitleTracks);
  console.log('\nUnique audio track names:\n ', Array.from(audioNames).sort(comparator).join('\n  '));
  console.log('\nUnique subtitles track names:\n ', Array.from(subtitlesNames).sort(comparator).join('\n  '));
  console.log('\nUnique TV show titles:\n ', Array.from(tvTitles).sort(comparator).join('\n  '));
  console.log('\nUnique movie show titles:\n ', Array.from(movieTitles).sort(comparator).join('\n  '));

  console.log('\nErrors:', errorCount);
})();
