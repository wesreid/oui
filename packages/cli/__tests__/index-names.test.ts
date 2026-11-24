/**
 * A name an agent's index gives an action, the rest of its id after its
 * surface's shared start, never runs another action: an agent runtime resolves
 * a full id first, so it keeps a surface's full ids on a route where a folded
 * name is another action's full id. The build warns of each such route.
 */
import { describe, expect, it } from 'vitest';

import { foldedNameCollisions } from '../src/index-names.js';

const surface = (id: string, routes: string[], names: string[]) => ({ id, routes, actions: names.map(name => ({ name })) });

describe('the names an index gives a page’s actions', () => {
  it('passes a route whose folded names are no other action’s id', () => {
    expect(
      foldedNameCollisions(
        [
          surface('room:video-editor', ['/editor'], ['video_editor_add_clip', 'video_editor_run_command', 'video_editor_split']),
          surface('room:vector-studio', ['/editor'], ['vector_studio_add_text', 'vector_studio_run_command', 'vector_studio_export']),
          surface('app:navigation', ['*'], ['app_navigate']),
        ],
        'oui-manifest.json',
      ),
    ).toEqual([]);
  });

  it('warns of a folded name that is another action’s full id on the same route, naming both', () => {
    const found = foldedNameCollisions(
      [
        surface('room:studio', ['/studio'], ['studio_app_navigate', 'studio_add', 'studio_move']),
        surface('app:navigation', ['*'], ['app_navigate']),
        // The same names on another route, where nothing is called app_navigate's way: not this route's problem twice.
        surface('room:other', ['/other'], ['other_a', 'other_b', 'other_c']),
      ],
      'oui-manifest.json',
    );
    expect(found).toEqual([
      {
        file: 'oui-manifest.json',
        line: 0,
        message:
          'On /studio, room:studio would list studio_app_navigate as "app_navigate" (its catalog\'s ids all start studio_), and "app_navigate" is ' +
          "app:navigation's action there, so an agent's index lists room:studio with its full ids on /studio. Give one of them another id to fold it.",
      },
    ]);
  });

  it('says a name that is the surface’s own action is its own', () => {
    const [found] = foldedNameCollisions([surface('room:song', ['/compose'], ['song_song_x', 'song_x', 'song_y'])], 'm.json');
    expect(found.message).toBe(
      'On /compose, room:song would list song_song_x as "song_x" (its catalog\'s ids all start song_), and "song_x" is its own action, ' +
        "so an agent's index lists room:song with its full ids on /compose. Give one of them another id to fold it.",
    );
  });

  it('reports a collision once however many routes share the surfaces', () => {
    const found = foldedNameCollisions(
      [surface('room:studio', ['/a', '/b'], ['studio_app_navigate', 'studio_add', 'studio_move']), surface('app:navigation', ['*'], ['app_navigate'])],
      'm.json',
    );
    expect(found).toHaveLength(1);
  });
});
