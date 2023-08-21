I'm making this code public as sample code. It's far from being a fully-fleshed-out tool for organizing MKV files and MKV metadata. There is no proper user interface &mdash; variables in the code have to be edited to change things like the source directory and other options.

This code is built around my own quirky way of organizing my video library, with these main goals:

- Making sure the way I name audio and subtitle tracks was consistent.
- Making sure MKV flags for original language, commentary, hearing impairment, and visual impairment are properly set.
- Maintaining older modification dates for files I encoded a long time ago, so I can easily distinguish my work from a decade or more ago from my newer work (starting in 2023) by looking at file modification dates.
- Renaming all of my TV episode files to match file naming conventions which help my Zidoo Z1O Pro media player match TVDB/TVmaze metadata. (I suspect this naming helps other media players as well.)
- Creating a report with the media characteristics, audio tracks, and subtitles of each MKV file, as well generating summary info about number of movies, TV shows, and episodes in my entire collection, including counts that eliminate duplicate variants of the same movies and shows. (For example, each *Lord of the Rings* movie in my collection exists as both 4K and 2K resolution, and both the theatrical and extended cuts. These four files are, however, counted as only one movie, however.)

This is a list of some peculiarities of my file organization, track naming conventions, and metadata handling, to help make sense out of what might otherwise look strange about my code.

- I have numerous symbolic links in my collection, like a folder named "Marvel Studios •" which contains a release-ordered list of symbolic links to the folders containing each individual Marvel movie. Symbolic links can greatly confuse the Zidoo, however, so each link ends with a `~` character, and my player settings tell the Zidoo to ignore all files and directories containing a `~`. (The Zidoo has no explicit setting to ignore symbolic links.)
- All folders containing a single TV series end with the `§` character. I do this as my way to distinguish TV shows from movies, without segregating TV and movies into two completely separate directories.
- All folders containing multiple movies or TV shows end with the `•` character.
- I use the full name of a language, like "English" or "French" for full subtitle tracks. I use two-letter language codes, like 'en' or 'fr', for subtitle tracks which contain only the forced subtitles needed for a particular language.
- I'm fond of keeping some normally-disallowed characters in file names, like question marks `?` and colons `:` by using the Unicode full-width variants of these characters instead.
- Every movie and TV show is wrapped inside a folder, so the root level of my collection has no files, only folders. The names of these folders are modified as needed to maintain sensible alphabetic sorting, like "Adventures of Baron Munchausen, The" rather than "The Adventures of Baron Munchausen".
- TV shows are organized inside a folder bearing the show's name, with folders for each season inside of that folder. A Season 1 folder may be omitted when there is only one season, and no future seasons are expected.
- All bonus materials and extras are stored in folders names "-Extras-".

Some sample output:

```
file: Ant-Man and the Wasp - Quantumania.mkv
            Title: Ant-Man and the Wasp: Quantumania
         Duration: 2:04:29.34, 27 chapters
            Video: H.265 10-bit HDR UHD, 2.39:1
          Audio 1: English TrueHD Atmos 7.1 (primary audio) <O>
          Audio 2: English Dolby PL2 [English MP3 Dolby PL2] <O>
          Audio 3: English DA [English AC-3 Stereo] <OV>
          Audio 4: Commentary [English AC-3 Stereo] <OC>
          Audio 5: French 5.1 [French AC-3 5.1]
          Audio 6: Spanish 5.1 [Spanish AC-3 5.1]
      Subtitles 1: PGS en, English SDH <OH>
      Subtitles 2: PGS en, Commentary <OC>
      Subtitles 3: PGS fr, French
      Subtitles 4: PGS es, Spanish
      Subtitles 5: PGS fr, fr
      Subtitles 6: PGS es, es

```

```
Video count: 2266
Movies (raw): 701, TV episodes (raw): 1565, Extras: 2003
Movies (unique): 589, TV episodes (unique): 1437
Movies: 9856.62GB, TV: 3809.61GB, Extras: 953.79GB
Other count: 1
Updated: 0
Legacy rips: 1186
Has unnamed subtitle tracks: 0
```
