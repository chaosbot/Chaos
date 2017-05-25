module.exports = {
    context: __dirname + '/app',
    entry: './bootstrap.jsx',
    output: {
        path: __dirname + '/',
        filename: 'index.js'
    },
    resolve: {
        extensions: ['.jsx', '.js', '.json']
    },
    module: {
      rules: [
        {
          test: /\.jsx$/,
          exclude: /(node_modules|bower_components)/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: ['es2015'],
              plugins: [['transform-react-jsx', { 'pragma':'h' }]]
            }
          }
        }
      ]
  }
}
