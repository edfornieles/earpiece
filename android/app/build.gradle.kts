plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.edfornieles.earpiece"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.edfornieles.earpiece"
        minSdk = 24
        targetSdk = 34
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.0." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0")
    }

    // A fixed key (app/earpiece.keystore) lets each new build install over the last one.
    // If it isn't in the repo, the standard debug key is used instead.
    val fixedKey = file("earpiece.keystore")
    signingConfigs {
        if (fixedKey.exists()) create("earpiece") {
            storeFile = fixedKey
            storePassword = "earpiece"
            keyAlias = "earpiece"
            keyPassword = "earpiece"
        }
    }
    buildTypes {
        getByName("debug") { if (fixedKey.exists()) signingConfig = signingConfigs.getByName("earpiece") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint { abortOnError = false; checkReleaseBuilds = false }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
