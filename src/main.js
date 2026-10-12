import Phaser from 'phaser';
import { GAME_VIEW } from './config.js';
import { GameScene } from './scenes/GameScene.js';
import { ui } from './ui.js';
import './style.css';

const config = {
  type: Phaser.AUTO,
  parent: 'game-container',
  width: GAME_VIEW.width,
  height: GAME_VIEW.height,
  backgroundColor: '#05070a',
  physics: {
    default: 'arcade',
    arcade: {
      debug: false,
      fps: 60
    }
  },
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  render: {
    antialias: true,
    pixelArt: false
  },
  scene: [GameScene]
};

const game = new Phaser.Game(config);

// Exposed for headless smoke-tests and future debugging.
window.__game = game;

// Restart + colony bound exactly once (UI module guards duplicates).
ui.bind(() => {
  const scene = game.scene.getScene('Game');
  if (scene) scene.scene.restart();
});
ui.bindColony(() => {
  const scene = game.scene.getScene('Game');
  if (scene) scene.openColony();
});
ui.bindArtifacts(() => {
  const scene = game.scene.getScene('Game');
  if (scene) scene.openArtifacts();
});

export default game;
