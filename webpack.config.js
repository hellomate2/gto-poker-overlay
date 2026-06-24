const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  entry: {
    'content-script': './src/content-script/index.ts',
    'background': './src/background.ts',
    'popup': './src/ui/popup.ts',
    'cfr-worker': './src/workers/cfr-worker.ts',
    'trainer': './src/trainer/index.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: 'manifest.json' },
        { from: 'src/ui/overlay.css', to: 'overlay.css' },
      ],
    }),
    new HtmlWebpackPlugin({
      template: './src/ui/popup.html',
      filename: 'popup.html',
      chunks: ['popup'],
    }),
    new HtmlWebpackPlugin({
      template: './src/trainer/trainer.html',
      filename: 'trainer.html',
      chunks: ['trainer'],
    }),
  ],
  optimization: {
    minimize: false, // easier debugging
  },
  devtool: 'cheap-module-source-map',
};
