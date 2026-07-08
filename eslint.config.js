import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/', 'dist/', 'build/', '*.config.js'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    plugins: {
      import: importPlugin,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.es2024,
        ...globals.node,
        ...globals.serviceworker,
        drizzle: 'readonly',
      },
    },
    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js'],
        },
      },
    },
    rules: {
      // 强制使用严格模式
      strict: ['error', 'global'],

      // 禁止使用 var
      'no-var': 'error',

      // 强制使用 const 声明常量
      'prefer-const': [
        'error',
        {
          destructuring: 'any',
          ignoreReadBeforeAssign: true,
        },
      ],

      // 禁止未使用的变量 (允许 _ 前缀)
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],

      // 要求使用箭头函数作为回调
      'prefer-arrow-callback': [
        'error',
        {
          allowNamedFunctions: false,
        },
      ],

      // 要求使用对象属性简写
      'object-shorthand': ['error', 'always'],

      // 允许使用 console
      'no-console': 'off',

      // 强制使用分号
      semi: ['error', 'always'],

      // 强制使用单引号
      quotes: ['error', 'single'],

      // 强制使用 === 和 !==
      eqeqeq: ['error', 'always'],

      // 禁止使用 == 和 !=
      'no-eq-null': 'error',

      // 禁止在块外使用变量
      'block-scoped-var': 'error',

      // 禁止不必要的 .call() 和 .apply()
      'no-useless-call': 'error',

      // 禁止不必要的字符串连接
      'no-useless-concat': 'error',

      // 禁止不必要的转义
      'no-useless-escape': 'error',

      // 强制模板字符串的使用
      'prefer-template': 'error',

      // 禁止不必要的布尔转换
      'no-extra-boolean-cast': 'error',

      // 要求使用 Rest 参数
      'prefer-rest-params': 'error',

      // 要求使用扩展运算符
      'prefer-spread': 'error',

      // 强制 return 语句的一致性
      'consistent-return': 'error',

      // 强制函数声明中的一致性
      'func-names': 'off',

      // 强制一致的换行风格
      'linebreak-style': ['error', 'unix'],

      // 强制每行最大长度
      'max-len': [
        'error',
        {
          code: 140,
          ignoreUrls: true,
        },
      ],

      // 禁止空块语句
      'no-empty': [
        'error',
        {
          allowEmptyCatch: true,
        },
      ],

      // 禁止空模式
      'no-empty-pattern': 'error',

      // 禁止使用 eval
      'no-eval': 'error',

      // 禁止扩展原生对象
      'no-extend-native': 'error',

      // 禁止隐式 eval
      'no-implied-eval': 'error',

      // 禁止在类外使用 this
      'no-invalid-this': 'error',

      // 禁止使用标签语句
      'no-label-var': 'error',

      // 禁止标签语句
      'no-labels': [
        'error',
        {
          allowLoop: false,
          allowSwitch: false,
        },
      ],

      // 禁止使用块语句
      'no-lone-blocks': 'error',

      // 禁止循环内的函数
      'no-loop-func': 'error',

      // 禁止混合运算符
      'no-mixed-operators': 'error',

      // 禁止混合空格和制表符
      'no-mixed-spaces-and-tabs': ['error', 'smart-tabs'],

      // 禁止多行字符串
      'no-multi-str': 'error',

      // 禁止嵌套三元表达式
      'no-nested-ternary': 'error',

      // 禁止 new 和 delete 与一元运算符一起使用
      'no-new': 'error',

      // 禁止使用 new Function
      'no-new-func': 'error',

      // 禁止使用 new Object()
      'no-new-object': 'error',

      // 禁止八进制字面量
      'no-octal': 'error',

      // 禁止使用 __proto__
      'no-proto': 'error',

      // 禁止重复的变量声明
      'no-redeclare': 'error',

      // 禁止正则表达式字面量中的转义
      'no-regex-spaces': 'error',

      // 禁止使用隐藏的局部变量
      'no-shadow-restricted-names': 'error',

      // 禁止稀疏数组
      'no-sparse-arrays': 'error',

      // 禁止使用 this 在构造函数中
      'no-this-before-super': 'error',

      // 禁止 throw 字面量
      'no-throw-literal': 'error',

      // 禁止返回已修改的对象
      'no-return-assign': ['error', 'always'],

      // 禁止使用脚本模式的字符串
      'no-script-url': 'error',

      // 禁止自动分号插入
      'no-unexpected-multiline': 'error',

      // 尾随空格
      'no-trailing-spaces': [
        'error',
        {
          ignoreComments: false,
        },
      ],

      // 禁止函数声明前的空格
      'space-before-function-paren': ['error', 'always'],

      // 禁止在行首使用括号
      'no-extra-parens': ['error', 'functions'],

      // 强制一元运算符后有空格
      'space-unary-ops': [
        'error',
        {
          words: true,
          nonwords: false,
        },
      ],

      // 要求使用 rest 参数
      'prefer-object-spread': 'error',

      // 禁止在循环中使用 await
      'no-await-in-loop': 'off',
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.vitest,
      },
    },
  },
  {
    // Root-level Node scripts (build.js, r2-utils.js) — not part of the
    // Worker bundle, so they get Node globals instead of the
    // serviceworker/drizzle set used by src/.
    files: ['*.js', '!eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  prettierConfig,
];
