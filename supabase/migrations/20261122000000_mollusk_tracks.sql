-- Undo the Nov 19 tracklist recheck: it kept "the longest list" and picked up a 70+ song
-- release for The Mollusk. Albums it touched are cleared so the usual lookup fills them in
-- again; The Mollusk gets its real 14 songs (Elektra, 1997).
update club.albums set tracks = null
 where id in (select split_part(key, '|', 2)::int from club.kv where key like 'tracks2|%')
   and not (lower(album) like '%mollusk%' and lower(artist) like '%ween%');

update club.albums set tracks = '[
  "I''m Dancing in the Show Tonight", "The Mollusk", "Polka Dot Tail",
  "I''ll Be Your Johnny on the Spot", "Mutilated Lips", "The Blarney Stone",
  "It''s Gonna Be a Long Night", "Buckingham Green", "Ocean Man",
  "She Wanted to Leave (Reprise)", "Pink Eye (On My Leg)", "Waving My Dick in the Wind",
  "Cold Blows the Wind", "She Wanted to Leave"
]'::jsonb
 where lower(album) like '%mollusk%' and lower(artist) like '%ween%';

delete from club.kv where key like 'tracks2|%';
